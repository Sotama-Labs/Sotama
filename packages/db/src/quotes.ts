import { getPool } from "./index";
import type { PairDirection } from "@sotama/market-core";

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
