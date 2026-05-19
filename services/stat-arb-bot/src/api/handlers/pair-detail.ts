/** `GET /api/pairs/:id` — full research dossier for a pair. */

import type http from "node:http";
import {
  basisHistory,
  basisQualityDistribution,
  basisRegimeSummary,
  closedSignals,
  getPair,
  latestBasisPerKey,
  quoteStatsByPair,
  recentQuotesForPair,
} from "@sotama/db";
import type {
  CostInputsBps,
  PairDetailDto,
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
  LATEST_WITHIN_MS,
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
  const [latest, signals, regimeRows, qualityRows, quoteStats, quoteRows, ...historyArrays] = await Promise.all([
    latestBasisPerKey({ withinMs: LATEST_WITHIN_MS }),
    closedSignals({ pairId: id, sinceMs: signalSinceMs }),
    basisRegimeSummary({ pairId: id, sinceMs }),
    basisQualityDistribution({ pairId: id, sinceMs }),
    quoteStatsByPair({ pairId: id, sinceMs }),
    recentQuotesForPair({ pairId: id, sinceMs }),
    ...pair.sizesUsd.flatMap((size) =>
      pair.directions.map((side) =>
        basisHistory({ pairId: id, side, sizeUsd: size, sinceMs }),
      ),
    ),
  ]);

  const latestForPair = latest.filter((b) => b.pairId === id);
  const buckets =
    groupBasisByPair(latestForPair).get(id) ??
    ({
      buyBySize: new Map(),
      sellBySize: new Map(),
    } as ReturnType<typeof groupBasisByPair> extends Map<string, infer V> ? V : never);
  const panelCore = buildPanelCore({ pair, buckets, nowMs });

  const historyRows = historyArrays
    .flat()
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const observationCount24h = historyRows.length;

  const liveEligibleSignals = signals.filter(
    (s) =>
      s.entryQualityStatus === "LIVE_ELIGIBLE" &&
      (s.exitQualityStatus ?? "LIVE_ELIGIBLE") === "LIVE_ELIGIBLE",
  );

  const pairReadiness = buildPairReadinessMatrix({
    pair,
    observations: historyRows.map(toReadinessObservation),
    quoteStats,
  });
  const twoSizeBacktest = runTwoSizeBacktestV2({
    observations: historyRows.map(toBacktestObservation),
    options: {
      minNetEdgeBps: pair.minNetEdgeBps,
      transactionCostBps,
      minLiveSamples: 20,
      researchOnly: pairReadiness.status !== "READY",
    },
  });
  const holdHorizonReplay = runHoldHorizonReplay({
    observations: historyRows.map(toHoldHorizonObservation),
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
            observations: historyRows.map(toStatObservation),
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
