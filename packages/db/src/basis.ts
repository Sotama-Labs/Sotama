import { getPool } from "./index";
import type { PairDirection, QuoteQualityStatus, TimeRegime } from "@sotama/market-core";

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
  pythConfidenceBps?: number | null;
  pythMarketSession?: string | null;
  quoteRequestStartedAt?: Date | null;
  quoteResponseAt?: Date | null;
  quoteRequestMs?: number | null;
  basisAgeMs?: number | null;
  quality?: "live" | "warm" | "stale" | "invalid";
  qualityStatus?: QuoteQualityStatus;
  qualityReason?: string;
  timeRegime?: TimeRegime | null;
};

export async function insertBasisObservation(row: BasisObservationInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO basis_observations
       (pair_id, side, size_usd, base_price_usd, token_price_usd,
        gross_edge_bps, net_edge_bps, tick_id, quote_id,
        pyth_stream_timestamp_us, pyth_feed_update_timestamp_us,
        pyth_freshness_lag_ms, pyth_confidence_bps, pyth_market_session,
        quote_request_started_at, quote_response_at, quote_request_ms,
        basis_age_ms, quality, quality_status, quality_reason, time_regime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
      row.pythConfidenceBps ?? null,
      row.pythMarketSession ?? null,
      row.quoteRequestStartedAt ?? null,
      row.quoteResponseAt ?? null,
      row.quoteRequestMs ?? null,
      row.basisAgeMs ?? null,
      row.quality ?? "live",
      row.qualityStatus ?? "LIVE_ELIGIBLE",
      row.qualityReason ?? "quote passed all live eligibility checks",
      row.timeRegime ?? null,
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
            pyth_freshness_lag_ms, pyth_confidence_bps, pyth_market_session,
            quote_request_started_at, quote_response_at, quote_request_ms,
            basis_age_ms, quality, quality_status, quality_reason, time_regime, observed_at
     FROM basis_observations
     WHERE pair_id = $1 AND side = $2 AND size_usd = $3
       AND observed_at >= to_timestamp($4 / 1000.0)
     ORDER BY observed_at ASC`,
    [args.pairId, args.side, args.sizeUsd, args.sinceMs],
  );
  return rows.map(mapBasisObservation);
}

/** Most recent basis observation for each (pair_id, side, size_usd) combination
 *  within the given staleness window. Powers the dashboard grid. */
export async function latestBasisPerKey(args: { withinMs: number }): Promise<BasisObservationRow[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (pair_id, side, size_usd)
            id, pair_id, side, size_usd, base_price_usd, token_price_usd,
            gross_edge_bps, net_edge_bps, tick_id, quote_id,
            pyth_stream_timestamp_us, pyth_feed_update_timestamp_us,
            pyth_freshness_lag_ms, pyth_confidence_bps, pyth_market_session,
            quote_request_started_at, quote_response_at, quote_request_ms,
            basis_age_ms, quality, quality_status, quality_reason, time_regime, observed_at
     FROM basis_observations
     WHERE observed_at >= now() - ($1 || ' milliseconds')::interval
     ORDER BY pair_id, side, size_usd, observed_at DESC`,
    [args.withinMs.toString()],
  );
  return rows.map(mapBasisObservation);
}

export type TimeRegimeSummaryRow = {
  timeRegime: TimeRegime;
  observationCount: number;
  liveCount: number;
  livePct: number;
  avgGrossBps: number | null;
  avgNetBps: number | null;
  maxNetBps: number | null;
  minNetBps: number | null;
  buyCount: number;
  sellCount: number;
  avgQuoteRequestMs: number | null;
  avgPythFreshnessLagMs: number | null;
  avgBasisAgeMs: number | null;
};

export async function basisRegimeSummary(args: {
  pairId: string;
  sinceMs: number;
}): Promise<TimeRegimeSummaryRow[]> {
  const { rows } = await getPool().query(
    `SELECT time_regime,
            COUNT(*)::int AS observation_count,
            COUNT(*) FILTER (WHERE quality_status = 'LIVE_ELIGIBLE')::int AS live_count,
            AVG(gross_edge_bps) AS avg_gross_bps,
            AVG(net_edge_bps) AS avg_net_bps,
            MAX(net_edge_bps) AS max_net_bps,
            MIN(net_edge_bps) AS min_net_bps,
            COUNT(*) FILTER (WHERE side = 'buy_tokenized')::int AS buy_count,
            COUNT(*) FILTER (WHERE side = 'sell_tokenized')::int AS sell_count,
            AVG(quote_request_ms) AS avg_quote_request_ms,
            AVG(pyth_freshness_lag_ms) AS avg_pyth_freshness_lag_ms,
            AVG(basis_age_ms) AS avg_basis_age_ms
     FROM basis_observations
     WHERE pair_id = $1
       AND observed_at >= to_timestamp($2 / 1000.0)
       AND time_regime IS NOT NULL
     GROUP BY time_regime
     ORDER BY time_regime ASC`,
    [args.pairId, args.sinceMs],
  );
  return rows.map((r: any) => {
    const observationCount = Number(r.observation_count);
    const liveCount = Number(r.live_count);
    return {
      timeRegime: r.time_regime,
      observationCount,
      liveCount,
      livePct: observationCount === 0 ? 0 : liveCount / observationCount,
      avgGrossBps: nullableNumber(r.avg_gross_bps),
      avgNetBps: nullableNumber(r.avg_net_bps),
      maxNetBps: nullableNumber(r.max_net_bps),
      minNetBps: nullableNumber(r.min_net_bps),
      buyCount: Number(r.buy_count),
      sellCount: Number(r.sell_count),
      avgQuoteRequestMs: nullableNumber(r.avg_quote_request_ms),
      avgPythFreshnessLagMs: nullableNumber(r.avg_pyth_freshness_lag_ms),
      avgBasisAgeMs: nullableNumber(r.avg_basis_age_ms),
    };
  });
}

export type QualityDistributionRow = {
  qualityStatus: QuoteQualityStatus;
  observationCount: number;
  observationPct: number;
};

/** Live-eligible observation counts for many pairs in a single round-trip.
 *  Used by the dashboard handler so it doesn't fan out N queries per refresh.
 *  Pairs with zero live rows in the window are simply absent from the map. */
export async function liveEligibleCountsByPair(args: {
  pairIds: readonly string[];
  sinceMs: number;
}): Promise<Map<string, number>> {
  if (args.pairIds.length === 0) return new Map();
  const { rows } = await getPool().query(
    `SELECT pair_id, COUNT(*)::int AS live_count
     FROM basis_observations
     WHERE quality_status = 'LIVE_ELIGIBLE'
       AND observed_at >= to_timestamp($1 / 1000.0)
       AND pair_id = ANY($2::text[])
     GROUP BY pair_id`,
    [args.sinceMs, args.pairIds as readonly string[]],
  );
  const out = new Map<string, number>();
  for (const r of rows as Array<{ pair_id: string; live_count: number }>) {
    out.set(r.pair_id, Number(r.live_count));
  }
  return out;
}

export async function basisQualityDistribution(args: {
  pairId: string;
  sinceMs: number;
}): Promise<QualityDistributionRow[]> {
  const { rows } = await getPool().query(
    `WITH counts AS (
       SELECT quality_status, COUNT(*)::int AS observation_count
       FROM basis_observations
       WHERE pair_id = $1
         AND observed_at >= to_timestamp($2 / 1000.0)
       GROUP BY quality_status
     ),
     total AS (
       SELECT COALESCE(SUM(observation_count), 0)::int AS total_count FROM counts
     )
     SELECT counts.quality_status, counts.observation_count, total.total_count
     FROM counts CROSS JOIN total
     ORDER BY counts.observation_count DESC, counts.quality_status ASC`,
    [args.pairId, args.sinceMs],
  );
  return rows.map((r: any) => {
    const observationCount = Number(r.observation_count);
    const total = Number(r.total_count);
    return {
      qualityStatus: r.quality_status,
      observationCount,
      observationPct: total === 0 ? 0 : observationCount / total,
    };
  });
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function mapBasisObservation(r: any): BasisObservationRow {
  return {
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
    pythConfidenceBps:
      r.pyth_confidence_bps == null ? null : Number(r.pyth_confidence_bps),
    pythMarketSession: r.pyth_market_session ?? null,
    quoteRequestStartedAt: r.quote_request_started_at,
    quoteResponseAt: r.quote_response_at,
    quoteRequestMs: r.quote_request_ms == null ? null : Number(r.quote_request_ms),
    basisAgeMs: r.basis_age_ms == null ? null : Number(r.basis_age_ms),
    quality: r.quality ?? "live",
    qualityStatus: r.quality_status ?? "LIVE_ELIGIBLE",
    qualityReason: r.quality_reason ?? "legacy row before quality gate",
    timeRegime: r.time_regime ?? null,
    observedAt: r.observed_at,
  };
}
