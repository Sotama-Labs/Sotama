import { getPool } from "./index";
import type { PairDirection } from "@sotama/market-core";

export type BasisObservationInsert = {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  grossBps: number;
  netBps: number;
  tickId: bigint | null;
  quoteId: bigint | null;
  pythStreamTimestampUs?: number | null;
  pythFeedUpdateTimestampUs?: number | null;
  pythFreshnessLagMs?: number | null;
  quoteRequestStartedAt?: Date | null;
  quoteResponseAt?: Date | null;
  quoteRequestMs?: number | null;
  basisAgeMs?: number | null;
  quality?: "live" | "warm" | "stale" | "invalid";
};

export async function insertBasisObservation(row: BasisObservationInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO basis_observations
       (pair_id, side, size_usd, base_price_usd, token_price_usd,
        gross_edge_bps, net_edge_bps, tick_id, quote_id,
        pyth_stream_timestamp_us, pyth_feed_update_timestamp_us,
        pyth_freshness_lag_ms, quote_request_started_at, quote_response_at,
        quote_request_ms, basis_age_ms, quality)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [
      row.pairId, row.side, row.sizeUsd,
      row.basePriceUsd, row.tokenPriceUsd,
      row.grossBps, row.netBps,
      row.tickId === null ? null : row.tickId.toString(),
      row.quoteId === null ? null : row.quoteId.toString(),
      row.pythStreamTimestampUs ?? null,
      row.pythFeedUpdateTimestampUs ?? null,
      row.pythFreshnessLagMs ?? null,
      row.quoteRequestStartedAt ?? null,
      row.quoteResponseAt ?? null,
      row.quoteRequestMs ?? null,
      row.basisAgeMs ?? null,
      row.quality ?? "live",
    ],
  );
  return BigInt(rows[0]!.id);
}

export type BasisObservationRow = BasisObservationInsert & {
  id: bigint;
  observedAt: Date;
};

export async function basisHistory(args: {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  sinceMs: number;
}): Promise<BasisObservationRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, pair_id, side, size_usd, base_price_usd, token_price_usd,
            gross_edge_bps, net_edge_bps, tick_id, quote_id,
            pyth_stream_timestamp_us, pyth_feed_update_timestamp_us,
            pyth_freshness_lag_ms, quote_request_started_at, quote_response_at,
            quote_request_ms, basis_age_ms, quality, observed_at
     FROM basis_observations
     WHERE pair_id = $1 AND side = $2 AND size_usd = $3
       AND observed_at >= to_timestamp($4 / 1000.0)
     ORDER BY observed_at ASC`,
    [args.pairId, args.side, args.sizeUsd, args.sinceMs],
  );
  return rows.map((r: any) => ({
    id: BigInt(r.id),
    pairId: r.pair_id,
    side: r.side,
    sizeUsd: Number(r.size_usd),
    basePriceUsd: Number(r.base_price_usd),
    tokenPriceUsd: Number(r.token_price_usd),
    grossBps: Number(r.gross_edge_bps),
    netBps: Number(r.net_edge_bps),
    tickId: r.tick_id == null ? null : BigInt(r.tick_id),
    quoteId: r.quote_id == null ? null : BigInt(r.quote_id),
    observedAt: r.observed_at,
  }));
}

/** Most recent basis observation for each (pair_id, side, size_usd) combination
 *  within the given staleness window. Powers the dashboard grid. */
export async function latestBasisPerKey(args: { withinMs: number }): Promise<BasisObservationRow[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (pair_id, side, size_usd)
            id, pair_id, side, size_usd, base_price_usd, token_price_usd,
            gross_edge_bps, net_edge_bps, tick_id, quote_id,
            pyth_stream_timestamp_us, pyth_feed_update_timestamp_us,
            pyth_freshness_lag_ms, quote_request_started_at, quote_response_at,
            quote_request_ms, basis_age_ms, quality, observed_at
     FROM basis_observations
     WHERE observed_at >= now() - ($1 || ' milliseconds')::interval
     ORDER BY pair_id, side, size_usd, observed_at DESC`,
    [args.withinMs.toString()],
  );
  return rows.map((r: any) => ({
    id: BigInt(r.id),
    pairId: r.pair_id,
    side: r.side,
    sizeUsd: Number(r.size_usd),
    basePriceUsd: Number(r.base_price_usd),
    tokenPriceUsd: Number(r.token_price_usd),
    grossBps: Number(r.gross_edge_bps),
    netBps: Number(r.net_edge_bps),
    tickId: r.tick_id == null ? null : BigInt(r.tick_id),
    quoteId: r.quote_id == null ? null : BigInt(r.quote_id),
    pythStreamTimestampUs:
      r.pyth_stream_timestamp_us == null ? null : Number(r.pyth_stream_timestamp_us),
    pythFeedUpdateTimestampUs:
      r.pyth_feed_update_timestamp_us == null ? null : Number(r.pyth_feed_update_timestamp_us),
    pythFreshnessLagMs:
      r.pyth_freshness_lag_ms == null ? null : Number(r.pyth_freshness_lag_ms),
    quoteRequestStartedAt: r.quote_request_started_at,
    quoteResponseAt: r.quote_response_at,
    quoteRequestMs: r.quote_request_ms == null ? null : Number(r.quote_request_ms),
    basisAgeMs: r.basis_age_ms == null ? null : Number(r.basis_age_ms),
    quality: r.quality ?? "live",
    observedAt: r.observed_at,
  }));
}
