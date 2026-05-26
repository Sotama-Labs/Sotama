/** `GET /api/pairs/:id` — full research dossier for a pair. */

import type http from "node:http";
import {
  basisHistory,
  closedSignals,
  getPair,
  recentQuotesForPair,
} from "@sotama/db";
import type {
  BasisObservationRow,
  JupiterQuoteRow,
  QualityDistributionRow,
  TimeRegimeSummaryRow,
} from "@sotama/db";
import type {
  CostInputsBps,
  PairDetailDto,
  PairReadinessQuoteStats,
  PairStatSummary,
} from "@sotama/market-core";
import { TtlCache } from "../cache";
import {
  buildCostScenarios,
  buildCostWaterfall,
  buildPairReadinessMatrix,
  buildRouteStability,
  buildStatSummary,
  runHoldHorizonReplay,
  runTwoSizeBacktestV2,
  summarize,
} from "@sotama/market-core";
import { sendJson } from "../http";
import {
  BASIS_SERIES_LIMIT,
  HISTORY_WINDOW_MS,
  HOLD_HORIZONS_MS,
  PAIR_DETAIL_HISTORY_LIMIT_PER_BUCKET,
  SIGNAL_WINDOW_MS,
  STAT_OPPORTUNITY_THRESHOLD_BPS,
  STAT_WINDOWS_MS,
} from "../constants";
import { buildPanelCore, groupBasisByPair } from "../builders/panel";
import {
  toBacktestObservation,
  toHoldHorizonObservation,
  toReadinessObservation,
  toStatObservation,
} from "../builders/observation-mappers";
import {
  downsample,
  toBasisSeriesPoint,
  toQualityDistribution,
  toQuoteSurface,
  toTimeRegimeSummary,
} from "../builders/quote-surface";
import { toRouteStabilityRow } from "../builders/route-stability";
import { buildVerdictFor } from "../builders/verdict";
import { toSignalHistory } from "../builders/signals";

export type PairDetailHandlerOptions = {
  costInputsBps: CostInputsBps;
  /** Returned in the DTO so the dashboard can label the active cost scenario. */
  costScenarioName?: string;
  /** Optional override for the route-failure haircut used in cost scenarios. */
  routeFailureHaircutBps?: number;
  /** TTL for the cached pair-detail body. */
  cacheTtlMs?: number;
};

/** Pair-detail recomputes hold-horizon replay, stat summary, and route
 *  stability — heavy enough to take ~10s per pair on a 1GB Postgres VM.
 *  Cache aggressively so a researcher refreshing the page (or two browser
 *  tabs polling) doesn't trigger redundant compute. 5-minute TTL is fine
 *  because hold-horizon + stat-summary inputs change on the minute scale
 *  at best; the researcher can hard-refresh if they need it sooner. */
const DEFAULT_PAIR_DETAIL_TTL_MS = 300_000;
const pairDetailCache = new TtlCache<PairDetailDto>(DEFAULT_PAIR_DETAIL_TTL_MS);

export async function handlePairDetail(
  res: http.ServerResponse,
  id: string,
  opts: PairDetailHandlerOptions,
): Promise<void> {
  const pair = await getPair(id);
  if (!pair) {
    sendJson(res, 404, { error: "pair not found", id });
    return;
  }
  const body = await pairDetailCache.memo(
    `pair:${id}`,
    () => computePairDetail(pair, opts),
    { ttlMs: opts.cacheTtlMs },
  );
  sendJson(res, 200, body);
}

async function computePairDetail(
  pair: NonNullable<Awaited<ReturnType<typeof getPair>>>,
  opts: PairDetailHandlerOptions,
): Promise<PairDetailDto> {
  const id = pair.id;

  const costs = opts.costInputsBps;
  const transactionCostBps =
    costs.slippageBufferBps + costs.landingCostBps + costs.failureBufferBps;

  const nowMs = Date.now();
  const sinceMs = nowMs - HISTORY_WINDOW_MS;
  const signalSinceMs = nowMs - SIGNAL_WINDOW_MS;
  const [signals, quoteRows, ...historyArrays] = await Promise.all([
    closedSignals({ pairId: id, sinceMs: signalSinceMs }),
    recentQuotesForPair({ pairId: id, sinceMs }),
    ...pair.sizesUsd.flatMap((size) =>
      pair.directions.map((side) =>
        basisHistory({
          pairId: id,
          side,
          sizeUsd: size,
          sinceMs,
          limit: PAIR_DETAIL_HISTORY_LIMIT_PER_BUCKET,
        }),
      ),
    ),
  ]);

  const historyRows = historyArrays
    .flat()
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const latestForPair = latestRowsBySideSize(historyRows);
  const buckets =
    groupBasisByPair(latestForPair).get(id) ??
    ({
      buyBySize: new Map(),
      sellBySize: new Map(),
    } as ReturnType<typeof groupBasisByPair> extends Map<string, infer V> ? V : never);
  const panelCore = buildPanelCore({ pair, buckets, nowMs });
  const qualityRows = buildQualityDistributionRows(historyRows);
  const regimeRows = buildRegimeSummaryRows(historyRows);
  const quoteStats = buildQuoteStatsFromRows(quoteRows);
  const observationCount24h = historyRows.length;
  const readinessObservations = historyRows.map(toReadinessObservation);
  const backtestObservations = historyRows.map(toBacktestObservation);
  const holdHorizonObservations = historyRows.map(toHoldHorizonObservation);
  const statObservations = historyRows.map(toStatObservation);

  const liveEligibleSignals = signals.filter(
    (s) =>
      s.entryQualityStatus === "LIVE_ELIGIBLE" &&
      (s.exitQualityStatus ?? "LIVE_ELIGIBLE") === "LIVE_ELIGIBLE",
  );

  const pairReadiness = buildPairReadinessMatrix({
    pair,
    observations: readinessObservations,
    quoteStats,
  });
  const twoSizeBacktest = runTwoSizeBacktestV2({
    observations: backtestObservations,
    options: {
      minNetEdgeBps: pair.minNetEdgeBps,
      transactionCostBps,
      minLiveSamples: 20,
      researchOnly: pairReadiness.status !== "READY",
    },
  });
  const holdHorizonReplay = runHoldHorizonReplay({
    observations: holdHorizonObservations,
    options: {
      minNetEdgeBps: pair.minNetEdgeBps,
      transactionCostBps,
      horizonsMs: HOLD_HORIZONS_MS,
    },
  });

  const statSummary: PairStatSummary[] = [];
  for (const windowMs of STAT_WINDOWS_MS) {
    for (const side of pair.directions) {
      for (const sizeUsd of pair.sizesUsd) {
        statSummary.push(
          buildStatSummary({
            side,
            sizeUsd,
            observations: statObservations,
            nowMs,
            options: {
              windowMs,
              opportunityThresholdBps: STAT_OPPORTUNITY_THRESHOLD_BPS,
            },
          }),
        );
      }
    }
  }

  const routeStability = buildRouteStability({
    rows: quoteRows.map(toRouteStabilityRow),
    options: { windowMs: HISTORY_WINDOW_MS },
  });

  const qualityDistribution = toQualityDistribution(qualityRows);
  const { verdict, tokenValidation } = buildVerdictFor({
    pair,
    pairReadiness,
    qualityDistribution,
    holdHorizonReplay,
    statSummary,
    routeStability,
    costInputsBps: costs,
    cleanWindowMs: HISTORY_WINDOW_MS,
  });

  // Cost waterfall is anchored to the freshest live-eligible gross edge if
  // we have one, otherwise the freshest diagnostic edge. We use buy-side as
  // the canonical "current opportunity" direction.
  const referenceGrossBps =
    panelCore.currentOpportunity.bestBuy?.netBps != null
      ? panelCore.currentOpportunity.bestBuy.netBps +
        costs.slippageBufferBps + costs.landingCostBps + costs.failureBufferBps + costs.minProfitBps
      : (panelCore.bestDiagnosticBuy?.netBps ?? 0) +
        costs.slippageBufferBps + costs.landingCostBps + costs.failureBufferBps + costs.minProfitBps;
  const costWaterfall = buildCostWaterfall({ grossBps: referenceGrossBps, costs });
  const costScenarios = buildCostScenarios({
    grossBps: referenceGrossBps,
    baseCosts: costs,
    routeFailureHaircutBps: opts.routeFailureHaircutBps,
  });

  const liveSampleCount24h = qualityDistribution.find(
    (row) => row.qualityStatus === "LIVE_ELIGIBLE",
  )?.observationCount ?? 0;

  const body: PairDetailDto = {
    pair,
    pairClass: panelCore.orientation.pairClass,
    displayLabel: panelCore.orientation.displayLabel,
    referenceStatus: panelCore.orientation.referenceStatus,
    verdict,
    currentOpportunity: panelCore.currentOpportunity,
    bestDiagnosticBuy: panelCore.bestDiagnosticBuy,
    bestDiagnosticSell: panelCore.bestDiagnosticSell,
    observationCount24h,
    liveSampleCount24h,
    quoteSurface: toQuoteSurface(latestForPair),
    basisSeries: downsample(historyRows, BASIS_SERIES_LIMIT).map(toBasisSeriesPoint),
    qualityDistribution,
    timeRegimeSummary: toTimeRegimeSummary(pair.base.assetClass, regimeRows),
    pairReadiness,
    twoSizeBacktest,
    holdHorizonReplay,
    statSummary,
    routeStability,
    tokenValidation,
    costWaterfall,
    costScenarios,
    costInputsBps: costs,
    signalHistory: signals.slice(-50).map(toSignalHistory),
    profitability: summarize(
      liveEligibleSignals.map((s) => ({
        entryAt: s.entryAt.getTime(),
        exitAt: s.exitAt.getTime(),
        pnlUsd: s.pnlUsd,
        edgeBps: s.entryEdgeBps,
      })),
      nowMs,
    ),
    bestBuy: panelCore.bestBuy,
    bestSell: panelCore.bestSell,
    bestSpread: panelCore.bestSpread,
    quoteAgeMs: panelCore.quoteAgeMs,
  };
  return body;
}

function latestRowsBySideSize(rows: readonly BasisObservationRow[]): BasisObservationRow[] {
  const byKey = new Map<string, BasisObservationRow>();
  for (const row of rows) {
    byKey.set(`${row.side}|${row.sizeUsd}`, row);
  }
  return [...byKey.values()];
}

function buildQualityDistributionRows(
  rows: readonly BasisObservationRow[],
): QualityDistributionRow[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const qualityStatus = row.qualityStatus ?? "LIVE_ELIGIBLE";
    counts.set(qualityStatus, (counts.get(qualityStatus) ?? 0) + 1);
  }
  const total = rows.length;
  return [...counts.entries()]
    .map(([qualityStatus, observationCount]) => ({
      qualityStatus: qualityStatus as QualityDistributionRow["qualityStatus"],
      observationCount,
      observationPct: total === 0 ? 0 : observationCount / total,
    }))
    .sort((a, b) => b.observationCount - a.observationCount ||
      a.qualityStatus.localeCompare(b.qualityStatus));
}

function buildRegimeSummaryRows(
  rows: readonly BasisObservationRow[],
): TimeRegimeSummaryRow[] {
  type Acc = {
    timeRegime: NonNullable<BasisObservationRow["timeRegime"]>;
    observationCount: number;
    liveCount: number;
    grossSum: number;
    netSum: number;
    maxNetBps: number | null;
    minNetBps: number | null;
    buyCount: number;
    sellCount: number;
    quoteRequestMsSum: number;
    quoteRequestMsCount: number;
    pythFreshnessLagMsSum: number;
    pythFreshnessLagMsCount: number;
    basisAgeMsSum: number;
    basisAgeMsCount: number;
  };
  const byRegime = new Map<string, Acc>();
  for (const row of rows) {
    if (!row.timeRegime) continue;
    const acc = byRegime.get(row.timeRegime) ?? {
      timeRegime: row.timeRegime,
      observationCount: 0,
      liveCount: 0,
      grossSum: 0,
      netSum: 0,
      maxNetBps: null,
      minNetBps: null,
      buyCount: 0,
      sellCount: 0,
      quoteRequestMsSum: 0,
      quoteRequestMsCount: 0,
      pythFreshnessLagMsSum: 0,
      pythFreshnessLagMsCount: 0,
      basisAgeMsSum: 0,
      basisAgeMsCount: 0,
    };
    acc.observationCount += 1;
    if (row.qualityStatus === "LIVE_ELIGIBLE") acc.liveCount += 1;
    acc.grossSum += row.grossBps;
    acc.netSum += row.netBps;
    acc.maxNetBps = acc.maxNetBps == null ? row.netBps : Math.max(acc.maxNetBps, row.netBps);
    acc.minNetBps = acc.minNetBps == null ? row.netBps : Math.min(acc.minNetBps, row.netBps);
    if (row.side === "buy_tokenized") acc.buyCount += 1;
    else acc.sellCount += 1;
    if (row.quoteRequestMs != null) {
      acc.quoteRequestMsSum += row.quoteRequestMs;
      acc.quoteRequestMsCount += 1;
    }
    if (row.pythFreshnessLagMs != null) {
      acc.pythFreshnessLagMsSum += row.pythFreshnessLagMs;
      acc.pythFreshnessLagMsCount += 1;
    }
    if (row.basisAgeMs != null) {
      acc.basisAgeMsSum += row.basisAgeMs;
      acc.basisAgeMsCount += 1;
    }
    byRegime.set(row.timeRegime, acc);
  }
  return [...byRegime.values()]
    .map((acc) => ({
      timeRegime: acc.timeRegime,
      observationCount: acc.observationCount,
      liveCount: acc.liveCount,
      livePct: acc.observationCount === 0 ? 0 : acc.liveCount / acc.observationCount,
      avgGrossBps: acc.grossSum / acc.observationCount,
      avgNetBps: acc.netSum / acc.observationCount,
      maxNetBps: acc.maxNetBps,
      minNetBps: acc.minNetBps,
      buyCount: acc.buyCount,
      sellCount: acc.sellCount,
      avgQuoteRequestMs: avg(acc.quoteRequestMsSum, acc.quoteRequestMsCount),
      avgPythFreshnessLagMs: avg(acc.pythFreshnessLagMsSum, acc.pythFreshnessLagMsCount),
      avgBasisAgeMs: avg(acc.basisAgeMsSum, acc.basisAgeMsCount),
    }))
    .sort((a, b) => a.timeRegime.localeCompare(b.timeRegime));
}

function buildQuoteStatsFromRows(
  rows: readonly JupiterQuoteRow[],
): PairReadinessQuoteStats[] {
  type Acc = {
    side: JupiterQuoteRow["side"];
    sizeUsd: number;
    totalCount: number;
    okCount: number;
    routers: Map<string, number>;
  };
  const byKey = new Map<string, Acc>();
  for (const row of rows) {
    const key = `${row.side}|${row.sizeUsd}`;
    const acc = byKey.get(key) ?? {
      side: row.side,
      sizeUsd: row.sizeUsd,
      totalCount: 0,
      okCount: 0,
      routers: new Map<string, number>(),
    };
    acc.totalCount += 1;
    if (row.status === "ok") {
      acc.okCount += 1;
      const router = row.router ?? "UNKNOWN";
      acc.routers.set(router, (acc.routers.get(router) ?? 0) + 1);
    }
    byKey.set(key, acc);
  }
  return [...byKey.values()]
    .map((acc) => ({
      side: acc.side,
      sizeUsd: acc.sizeUsd,
      totalCount: acc.totalCount,
      okCount: acc.okCount,
      routerDistribution: [...acc.routers.entries()]
        .map(([router, count]) => ({
          router,
          count,
          pct: acc.totalCount === 0 ? 0 : count / acc.totalCount,
        }))
        .sort((a, b) => b.count - a.count || a.router.localeCompare(b.router)),
    }))
    .sort((a, b) => a.side.localeCompare(b.side) || a.sizeUsd - b.sizeUsd);
}

function avg(sum: number, count: number): number | null {
  return count === 0 ? null : sum / count;
}
