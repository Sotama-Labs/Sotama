/** Heartbeat row → HeartbeatDto mapper. */

import type { HeartbeatDto, SchedulerTelemetryDto } from "@sotama/market-core";

export function toHeartbeatDto(
  hb: {
    observedAt: Date;
    activePairCount: number;
    currentRps: number;
    http429Count1m: number;
    errorCount1m: number;
    streamLagMs: number | null;
    quoteLagMs: number | null;
    activeLazerEndpointCount?: number | null;
    lazerEndpointHealth?: unknown | null;
    invalidFeedCount1m?: number;
  },
  schedulerTelemetry: SchedulerTelemetryDto | null = null,
): HeartbeatDto {
  return {
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
  };
}
