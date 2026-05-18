import { getPool } from "./index";
import type { PairDirection, PairReadinessQuoteStats } from "@sotama/market-core";

export type JupiterQuoteInsert = {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  router: string | null;
  inMint: string;
  outMint: string;
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number | null;
  quoteId?: string | null;
  expiresAt?: Date | null;
  contextSlot?: number | null;
  requestMs: number;
  status: "ok" | "rate_limited" | "error" | "stale";
  raw: unknown | null;
};

export async function insertJupiterQuote(row: JupiterQuoteInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO jupiter_quotes
       (pair_id, side, size_usd, router, in_mint, out_mint,
        in_amount, out_amount, price_impact_pct, quote_id, expires_at,
        context_slot, request_ms, status, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      row.pairId,
      row.side,
      row.sizeUsd,
      row.router,
      row.inMint,
      row.outMint,
      row.inAmount.toString(),
      row.outAmount.toString(),
      row.priceImpactPct,
      row.quoteId ?? null,
      row.expiresAt ?? null,
      row.contextSlot ?? null,
      row.requestMs,
      row.status,
      row.raw == null ? null : JSON.stringify(row.raw),
    ],
  );
  return BigInt(rows[0]!.id);
}

export type JupiterQuoteRow = JupiterQuoteInsert & {
  id: bigint;
  receivedAt: Date;
};

export async function recentQuotes(args: {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  limit: number;
}): Promise<JupiterQuoteRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, pair_id, side, size_usd, router, in_mint, out_mint,
            in_amount, out_amount, price_impact_pct, quote_id, expires_at,
            context_slot, request_ms, status, raw, received_at
     FROM jupiter_quotes
     WHERE pair_id = $1 AND side = $2 AND size_usd = $3
     ORDER BY received_at DESC
     LIMIT $4`,
    [args.pairId, args.side, args.sizeUsd, args.limit],
  );
  return rows.map(rowToQuote);
}

/** Flat list of recent quote rows for a pair across every side+size. Used by
 *  the route-stability aggregator in the API layer; the SQL is intentionally
 *  light (no JSONB casts, no `raw`) because that column can be large and the
 *  consumer never inspects it. */
export async function recentQuotesForPair(args: {
  pairId: string;
  sinceMs: number;
  limit?: number;
}): Promise<JupiterQuoteRow[]> {
  const limit = args.limit ?? 5000;
  const { rows } = await getPool().query(
    `SELECT id, pair_id, side, size_usd, router, in_mint, out_mint,
            in_amount, out_amount, price_impact_pct, quote_id, expires_at,
            context_slot, request_ms, status, NULL::jsonb AS raw, received_at
     FROM jupiter_quotes
     WHERE pair_id = $1
       AND received_at >= to_timestamp($2 / 1000.0)
     ORDER BY received_at DESC
     LIMIT $3`,
    [args.pairId, args.sinceMs, limit],
  );
  return rows.map(rowToQuote);
}

export async function quoteStatsByPair(args: {
  pairId: string;
  sinceMs: number;
}): Promise<PairReadinessQuoteStats[]> {
  const { rows } = await getPool().query(
    `WITH quote_counts AS (
       SELECT side, size_usd,
              COUNT(*)::int AS total_count,
              COUNT(*) FILTER (WHERE status = 'ok')::int AS ok_count
       FROM jupiter_quotes
       WHERE pair_id = $1
         AND received_at >= to_timestamp($2 / 1000.0)
       GROUP BY side, size_usd
     ),
     router_counts AS (
       SELECT side, size_usd, COALESCE(router, 'UNKNOWN') AS router, COUNT(*)::int AS count
       FROM jupiter_quotes
       WHERE pair_id = $1
         AND received_at >= to_timestamp($2 / 1000.0)
         AND status = 'ok'
       GROUP BY side, size_usd, COALESCE(router, 'UNKNOWN')
     )
     SELECT q.side, q.size_usd, q.total_count, q.ok_count,
            COALESCE(
              jsonb_agg(
                jsonb_build_object('router', r.router, 'count', r.count)
                ORDER BY r.count DESC, r.router ASC
              ) FILTER (WHERE r.router IS NOT NULL),
              '[]'::jsonb
            ) AS router_distribution
     FROM quote_counts q
     LEFT JOIN router_counts r
       ON r.side = q.side AND r.size_usd = q.size_usd
     GROUP BY q.side, q.size_usd, q.total_count, q.ok_count
     ORDER BY q.side ASC, q.size_usd ASC`,
    [args.pairId, args.sinceMs],
  );
  return rows.map((r: any) => {
    const totalCount = Number(r.total_count);
    const distribution = Array.isArray(r.router_distribution)
      ? r.router_distribution
      : JSON.parse(r.router_distribution ?? "[]");
    return {
      side: r.side,
      sizeUsd: Number(r.size_usd),
      totalCount,
      okCount: Number(r.ok_count),
      routerDistribution: distribution.map((row: any) => ({
        router: String(row.router ?? "UNKNOWN"),
        count: Number(row.count),
        pct: totalCount === 0 ? 0 : Number(row.count) / totalCount,
      })),
    };
  });
}

function rowToQuote(r: any): JupiterQuoteRow {
  return {
    id: BigInt(r.id),
    pairId: r.pair_id,
    side: r.side,
    sizeUsd: Number(r.size_usd),
    router: r.router,
    inMint: r.in_mint,
    outMint: r.out_mint,
    inAmount: BigInt(r.in_amount),
    outAmount: BigInt(r.out_amount),
    priceImpactPct: r.price_impact_pct == null ? null : Number(r.price_impact_pct),
    quoteId: r.quote_id,
    expiresAt: r.expires_at,
    contextSlot: r.context_slot == null ? null : Number(r.context_slot),
    requestMs: r.request_ms,
    status: r.status,
    raw: r.raw,
    receivedAt: r.received_at,
  };
}
