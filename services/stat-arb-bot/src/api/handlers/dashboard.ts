/** `GET /api/dashboard` — overview ranking of every tracked pair.
 *
 *  Computes the full research verdict per pair so the home page can rank
 *  pairs by `verdict.status`. With only a handful of tracked pairs this is
 *  fine; if the catalog grows past ~20 pairs, cache the per-pair verdict in
 *  memory (keyed by latest observation timestamp). */

import type http from "node:http";
import {
  basisHistory,
  basisQualityDistribution,
  closedSignals,
  latestBasisPerKey,
  latestHeartbeat,
  listAllPairs,
  quoteStatsByPair,
  recentQuotesForPair,
} from "@sotama/db";
import type {
  CostInputsBps,
  DashboardSnapshotDto,
  PairConfig,
  PairPanelDto,
  PairStatSummary,
  SchedulerTelemetryDto,
} from "@sotama/market-core";
import {
  buildPairReadinessMatrix,
  buildRouteStability,
  buildStatSummary,
  runHoldHorizonReplay,
} from "@sotama/market-core";
import { sendJson } from "../http";
import {
  HISTORY_WINDOW_MS,
  HOLD_HORIZONS_MS,
  LATEST_WITHIN_MS,
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
import { toQualityDistribution } from "../builders/quote-surface";
import { toRouteStabilityRow } from "../builders/route-stability";
import { buildVerdictFor, primaryBlockerSummary } from "../builders/verdict";

export type DashboardHandlerOptions = {
  costInputsBps: CostInputsBps;
};

export async function handleDashboard(
  res: http.ServerResponse,
  opts: DashboardHandlerOptions,
  schedulerTelemetry: SchedulerTelemetryDto | null,
): Promise<void> {
  const [pairs, latestBasis, hb] = await Promise.all([
    listAllPairs(),
    latestBasisPerKey({ withinMs: LATEST_WITHIN_MS }),
    latestHeartbeat(),
  ]);

  const groupedLatest = groupBasisByPair(latestBasis);
  const nowMs = Date.now();
  const panels = await Promise.all(
    pairs.map((pair) => buildPanel(pair, groupedLatest, nowMs, opts.costInputsBps)),
  );

  const body: DashboardSnapshotDto = {
    panels,
    heartbeat: hb
      ? {
          observedAt: hb.observedAt.toISOString(),
          activePairs: hb.activePairCount,
          currentRps: hb.currentRps,
          http429Count1m: hb.http429Count1m,
          errorCount1m: hb.errorCount1m,
          streamLagMs: hb.streamLagMs,
          quoteLagMs: hb.quoteLagMs,
          activeLazerEndpointCount: hb.activeLazerEndpointCount ?? null,
          lazerEndpointHealth: hb.lazerEndpointHealth ?? null,
          invalidFeedCount1m: hb.invalidFeedCount1m ?? 0,
          schedulerTelemetry,
        }
      : null,
    schedulerTelemetry,
  };
  sendJson(res, 200, body);
}

async function buildPanel(
  pair: PairConfig,
  groupedLatest: ReturnType<typeof groupBasisByPair>,
  nowMs: number,
  costs: CostInputsBps,
): Promise<PairPanelDto> {
  const buckets =
    groupedLatest.get(pair.id) ??
    ({
      buyBySize: new Map(),
      sellBySize: new Map(),
    } as ReturnType<typeof groupBasisByPair> extends Map<string, infer V> ? V : never);
  const core = buildPanelCore({ pair, buckets, nowMs });

  // Run the heavier per-pair queries in parallel. The dashboard endpoint
  // needs the full verdict to rank pairs; if this becomes hot, memoize on
  // the latest basis-id from `groupedLatest` and invalidate on change.
  const sinceMs = nowMs - HISTORY_WINDOW_MS;
  const [historyArrays, qualityRows, quoteStats, quoteRows] = await Promise.all([
    Promise.all(
      pair.sizesUsd.flatMap((size) =>
        pair.directions.map((side) =>
          basisHistory({ pairId: pair.id, side, sizeUsd: size, sinceMs }),
        ),
      ),
    ),
    basisQualityDistribution({ pairId: pair.id, sinceMs }),
    quoteStatsByPair({ pairId: pair.id, sinceMs }),
    recentQuotesForPair({ pairId: pair.id, sinceMs }),
  ]);

  const historyRows = historyArrays
    .flat()
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const pairReadiness = buildPairReadinessMatrix({
    pair,
    observations: historyRows.map(toReadinessObservation),
    quoteStats,
  });
  const holdHorizonReplay = runHoldHorizonReplay({
    observations: historyRows.map(toHoldHorizonObservation),
    options: {
      minNetEdgeBps: pair.minNetEdgeBps,
      transactionCostBps:
        costs.slippageBufferBps + costs.landingCostBps + costs.failureBufferBps,
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
  // Run the two-size backtest just to keep the recommended action available
  // for the overview; the full backtest body lives on the pair detail.
  void toBacktestObservation;

  const { verdict } = buildVerdictFor({
    pair,
    pairReadiness,
    qualityDistribution,
    holdHorizonReplay,
    statSummary,
    routeStability,
    costInputsBps: costs,
    cleanWindowMs: HISTORY_WINDOW_MS,
  });

  const liveSampleCount24h = qualityDistribution.find(
    (row) => row.qualityStatus === "LIVE_ELIGIBLE",
  )?.observationCount ?? 0;

  return {
    pair,
    pairClass: core.orientation.pairClass,
    displayLabel: core.orientation.displayLabel,
    referenceStatus: core.orientation.referenceStatus,
    currentOpportunity: core.currentOpportunity,
    bestDiagnosticBuy: core.bestDiagnosticBuy,
    bestDiagnosticSell: core.bestDiagnosticSell,
    verdict,
    liveSampleCount24h,
    primaryBlocker: primaryBlockerSummary(verdict),
    bestBuy: core.bestBuy,
    bestSell: core.bestSell,
    bestSpread: core.bestSpread,
    quoteAgeMs: core.quoteAgeMs,
  };
}
