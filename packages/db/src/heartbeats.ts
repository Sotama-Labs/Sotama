import { getPool } from "./index";

export type HeartbeatInsert = {
  streamLagMs: number | null;
  quoteLagMs: number | null;
  activePairCount: number;
  currentRps: number;
  http429Count1m: number;
  errorCount1m: number;
  activeLazerEndpointCount?: number | null;
  lazerEndpointHealth?: unknown | null;
  invalidFeedCount1m?: number;
};

export async function recordHeartbeat(row: HeartbeatInsert): Promise<void> {
  await getPool().query(
    `INSERT INTO bot_heartbeats
       (stream_lag_ms, quote_lag_ms, active_pair_count, current_rps,
        http_429_count_1m, error_count_1m, active_lazer_endpoint_count,
        lazer_endpoint_health, invalid_feed_count_1m)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.streamLagMs,
      row.quoteLagMs,
      row.activePairCount,
      row.currentRps,
      row.http429Count1m,
      row.errorCount1m,
      row.activeLazerEndpointCount ?? null,
      row.lazerEndpointHealth == null ? null : JSON.stringify(row.lazerEndpointHealth),
      row.invalidFeedCount1m ?? 0,
    ],
  );
}

export type HeartbeatRow = HeartbeatInsert & {
  id: bigint;
  observedAt: Date;
};

export async function latestHeartbeat(): Promise<HeartbeatRow | null> {
  const { rows } = await getPool().query(
    `SELECT id, observed_at, stream_lag_ms, quote_lag_ms, active_pair_count,
            current_rps, http_429_count_1m, error_count_1m,
            active_lazer_endpoint_count, lazer_endpoint_health,
            invalid_feed_count_1m
     FROM bot_heartbeats
     ORDER BY observed_at DESC
     LIMIT 1`,
  );
  const r: any = rows[0];
  if (!r) return null;
  return {
    id: BigInt(r.id),
    observedAt: r.observed_at,
    streamLagMs: r.stream_lag_ms,
    quoteLagMs: r.quote_lag_ms,
    activePairCount: r.active_pair_count,
    currentRps: Number(r.current_rps),
    http429Count1m: r.http_429_count_1m,
    errorCount1m: r.error_count_1m,
    activeLazerEndpointCount: r.active_lazer_endpoint_count,
    lazerEndpointHealth: r.lazer_endpoint_health,
    invalidFeedCount1m: r.invalid_feed_count_1m ?? 0,
  };
}
