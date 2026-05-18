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
};

export async function insertBasisObservation(row: BasisObservationInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO basis_observations
       (pair_id, side, size_usd, base_price_usd, token_price_usd,
        gross_edge_bps, net_edge_bps, tick_id, quote_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      row.pairId, row.side, row.sizeUsd,
      row.basePriceUsd, row.tokenPriceUsd,
      row.grossBps, row.netBps,
      row.tickId === null ? null : row.tickId.toString(),
      row.quoteId === null ? null : row.quoteId.toString(),
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
            gross_edge_bps, net_edge_bps, tick_id, quote_id, observed_at
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
            gross_edge_bps, net_edge_bps, tick_id, quote_id, observed_at
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
    observedAt: r.observed_at,
  }));
}
