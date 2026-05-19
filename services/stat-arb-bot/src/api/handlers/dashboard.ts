/** `GET /api/dashboard` — overview ranking of every tracked pair.
 *
 *  Designed for high hit rate:
 *    - One aggregated SQL query for the per-pair live-eligible counts
 *      (no per-pair fanout to `basisQualityDistribution`).
 *    - In-memory `TtlCache` with a 60 s fresh window and a generous stale
 *      window so the dashboard survives Postgres flaps without 500s.
 *    - Per-pair work uses only the latest-basis bucket already in hand —
 *      no `basisHistory`, `recentQuotesForPair`, or in-process replay/stat. */

import type http from "node:http";
import {
  latestBasisPerKey,
  latestHeartbeat,
  liveEligibleCountsByPair,
  listAllPairs,
} from "@sotama/db";
import type {
  DashboardSnapshotDto,
  PairConfig,
  PairPanelDto,
  QuoteQualityDistributionDto,
  SchedulerTelemetryDto,
} from "@sotama/market-core";
import { TtlCache } from "../cache";
import { sendJson } from "../http";
import { HISTORY_WINDOW_MS, LATEST_WITHIN_MS } from "../constants";
import { buildPanelCore, groupBasisByPair } from "../builders/panel";
import { buildLiteVerdict } from "../builders/lite-verdict";
import { deriveTokenValidation, primaryBlockerSummary } from "../builders/verdict";

export type DashboardHandlerOptions = {
  /** TTL for the cached snapshot. Tunable; defaults to 60 s — long enough
   *  for high hit rate, short enough that the operator sees recent data. */
  cacheTtlMs?: number;
};

const DEFAULT_CACHE_TTL_MS = 60_000;
const snapshotCache = new TtlCache<DashboardSnapshotDto>(DEFAULT_CACHE_TTL_MS);

export async function handleDashboard(
  res: http.ServerResponse,
  opts: DashboardHandlerOptions,
  schedulerTelemetry: SchedulerTelemetryDto | null,
): Promise<void> {
  const snapshot = await snapshotCache.memo(
    "snapshot",
    () => buildSnapshot(schedulerTelemetry),
    { ttlMs: opts.cacheTtlMs },
  );
  // `schedulerTelemetry` is a live snapshot — overlay onto the (possibly
  // cached) body so the dashboard sees fresh counts even on cache hits.
  sendJson(res, 200, {
    ...snapshot,
    schedulerTelemetry,
    heartbeat: snapshot.heartbeat
      ? { ...snapshot.heartbeat, schedulerTelemetry }
      : null,
  });
}

async function buildSnapshot(
  schedulerTelemetry: SchedulerTelemetryDto | null,
): Promise<DashboardSnapshotDto> {
  const [pairs, latestBasis, hb] = await Promise.all([
    listAllPairs(),
    latestBasisPerKey({ withinMs: LATEST_WITHIN_MS }),
    latestHeartbeat(),
  ]);

  const groupedLatest = groupBasisByPair(latestBasis);
  const nowMs = Date.now();
  const sinceMs = nowMs - HISTORY_WINDOW_MS;
  const liveCounts = await liveEligibleCountsByPair({
    pairIds: pairs.map((p) => p.id),
    sinceMs,
  });

  const panels = pairs.map((pair) =>
    buildPanel(pair, groupedLatest, liveCounts.get(pair.id) ?? 0, nowMs),
  );

  return {
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
}

function buildPanel(
  pair: PairConfig,
  groupedLatest: ReturnType<typeof groupBasisByPair>,
  liveSampleCount24h: number,
  nowMs: number,
): PairPanelDto {
  const buckets =
    groupedLatest.get(pair.id) ??
    ({
      buyBySize: new Map(),
      sellBySize: new Map(),
    } as ReturnType<typeof groupBasisByPair> extends Map<string, infer V> ? V : never);
  const core = buildPanelCore({ pair, buckets, nowMs });

  // A pair has executable edge evidence on the overview when any LIVE_ELIGIBLE
  // latest-basis row clears the per-pair `minNetEdgeBps` threshold. Without
  // that, what looks like a "favorable" ratio is usually just the natural
  // Jupiter bid/ask spread (buy > 1 / sell < 1) — not real edge.
  const hasLiveEdgeAboveThreshold = [
    ...buckets.buyBySize.values(),
    ...buckets.sellBySize.values(),
  ].some(
    (row) =>
      row.qualityStatus === "LIVE_ELIGIBLE" && row.netBps >= pair.minNetEdgeBps,
  );

  // The lite verdict only inspects the live sample count; emit a single
  // synthetic distribution row so the existing input shape stays unchanged.
  const qualityDistribution: QuoteQualityDistributionDto[] =
    liveSampleCount24h > 0
      ? [
          {
            qualityStatus: "LIVE_ELIGIBLE",
            observationCount: liveSampleCount24h,
            observationPct: 1,
          },
        ]
      : [];
  const tokenValidation = deriveTokenValidation(pair);
  const verdict = buildLiteVerdict({
    pair,
    qualityDistribution,
    tokenValidation,
    hasLiveEdgeAboveThreshold,
    cleanWindowMs: HISTORY_WINDOW_MS,
  });

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
