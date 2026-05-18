/** `GET /api/dashboard` — overview ranking of every tracked pair.
 *
 *  Deliberately lightweight: per-pair work uses only quoteStats + quality
 *  distribution + the latest-basis bucket already fetched in one shot at the
 *  top. Heavy artefacts (basisHistory, hold-horizon replay, stat summary,
 *  route stability) live on the pair-detail endpoint — see
 *  `handlers/pair-detail.ts`. The result is memoized with a short TTL so
 *  repeated browser polls don't hit the DB at all. */

import type http from "node:http";
import {
  basisQualityDistribution,
  latestBasisPerKey,
  latestHeartbeat,
  listAllPairs,
  quoteStatsByPair,
} from "@sotama/db";
import type {
  DashboardSnapshotDto,
  PairConfig,
  PairPanelDto,
  SchedulerTelemetryDto,
} from "@sotama/market-core";
import { TtlCache } from "../cache";
import { sendJson } from "../http";
import { HISTORY_WINDOW_MS, LATEST_WITHIN_MS } from "../constants";
import { buildPanelCore, groupBasisByPair } from "../builders/panel";
import { toQualityDistribution } from "../builders/quote-surface";
import { buildLiteVerdict } from "../builders/lite-verdict";
import { deriveTokenValidation, primaryBlockerSummary } from "../builders/verdict";

export type DashboardHandlerOptions = {
  /** TTL for the cached snapshot. Tunable; defaults to 15s — short enough
   *  the operator sees fresh-ish ranking, long enough to absorb the
   *  per-second polling some browsers do. */
  cacheTtlMs?: number;
};

const DEFAULT_CACHE_TTL_MS = 15_000;
const snapshotCache = new TtlCache<DashboardSnapshotDto>(DEFAULT_CACHE_TTL_MS);

export async function handleDashboard(
  res: http.ServerResponse,
  opts: DashboardHandlerOptions,
  schedulerTelemetry: SchedulerTelemetryDto | null,
): Promise<void> {
  const snapshot = await snapshotCache.memo(
    "snapshot",
    () => buildSnapshot(schedulerTelemetry),
    opts.cacheTtlMs,
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
  const panels = await Promise.all(
    pairs.map((pair) => buildPanel(pair, groupedLatest, nowMs)),
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

async function buildPanel(
  pair: PairConfig,
  groupedLatest: ReturnType<typeof groupBasisByPair>,
  nowMs: number,
): Promise<PairPanelDto> {
  const buckets =
    groupedLatest.get(pair.id) ??
    ({
      buyBySize: new Map(),
      sellBySize: new Map(),
    } as ReturnType<typeof groupBasisByPair> extends Map<string, infer V> ? V : never);
  const core = buildPanelCore({ pair, buckets, nowMs });

  // Lite per-pair work: two aggregated queries that already happen in SQL.
  // Skips basisHistory + recentQuotesForPair (24h scans) and all in-process
  // replay/stat/route work — those run on the pair-detail endpoint instead.
  const sinceMs = nowMs - HISTORY_WINDOW_MS;
  const [qualityRows] = await Promise.all([
    basisQualityDistribution({ pairId: pair.id, sinceMs }),
    // quoteStatsByPair is fetched here purely to warm any DB-side cache and
    // catch errors early; the lite verdict does not consume it yet.
    quoteStatsByPair({ pairId: pair.id, sinceMs }),
  ]);

  const qualityDistribution = toQualityDistribution(qualityRows);
  const tokenValidation = deriveTokenValidation(pair);
  const verdict = buildLiteVerdict({
    pair,
    qualityDistribution,
    tokenValidation,
    cleanWindowMs: HISTORY_WINDOW_MS,
  });
  const liveSampleCount24h =
    qualityDistribution.find((row) => row.qualityStatus === "LIVE_ELIGIBLE")
      ?.observationCount ?? 0;

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
