import { getPool } from "./index";
import type { PairDirection } from "@sotama/market-core";

export type OpenSignalInsert = {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  thresholdBps: number;
  entryEdgeBps: number;
  entryTokenPriceUsd: number;
  entryBasePriceUsd: number;
  entryQuoteId: bigint | null;
  entryBasisId: bigint | null;
  tokenUnits: number;
  entryObservedAt: Date;
  entryAt: Date;
};

export async function openSignal(row: OpenSignalInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO paper_signals
       (pair_id, side, entry_side, size_usd, threshold_bps, entry_edge_bps,
        entry_token_price_usd, entry_base_price_usd, entry_quote_id, entry_basis_id,
        token_units, entry_observed_at, entry_at, outcome)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open')
     RETURNING id`,
    [
      row.pairId,
      row.side,
      row.sizeUsd,
      row.thresholdBps,
      row.entryEdgeBps,
      row.entryTokenPriceUsd,
      row.entryBasePriceUsd,
      row.entryQuoteId === null ? null : row.entryQuoteId.toString(),
      row.entryBasisId === null ? null : row.entryBasisId.toString(),
      row.tokenUnits,
      row.entryObservedAt,
      row.entryAt,
    ],
  );
  return BigInt(rows[0]!.id);
}

export type CloseSignalArgs = {
  id: bigint;
  exitEdgeBps: number;
  exitSide: PairDirection;
  exitTokenPriceUsd: number;
  exitBasePriceUsd: number;
  exitQuoteId: bigint | null;
  exitBasisId: bigint | null;
  exitObservedAt: Date;
  exitReason: "converged" | "stale";
  pnlUsd: number;
  outcome: "closed_win" | "closed_loss" | "closed_flat" | "closed_stale";
  exitAt: Date;
};

export async function closeSignal(args: CloseSignalArgs): Promise<void> {
  await getPool().query(
    `UPDATE paper_signals
     SET exit_at = $2, exit_edge_bps = $3, pnl_usd = $4, outcome = $5,
         exit_side = $6, exit_token_price_usd = $7, exit_base_price_usd = $8,
         exit_quote_id = $9, exit_basis_id = $10, exit_observed_at = $11,
         exit_reason = $12
     WHERE id = $1`,
    [
      args.id.toString(),
      args.exitAt,
      args.exitEdgeBps,
      args.pnlUsd,
      args.outcome,
      args.exitSide,
      args.exitTokenPriceUsd,
      args.exitBasePriceUsd,
      args.exitQuoteId === null ? null : args.exitQuoteId.toString(),
      args.exitBasisId === null ? null : args.exitBasisId.toString(),
      args.exitObservedAt,
      args.exitReason,
    ],
  );
}

export type OpenSignalRow = {
  id: bigint;
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  thresholdBps: number;
  entryEdgeBps: number;
  entryTokenPriceUsd: number | null;
  entryBasePriceUsd: number | null;
  entryQuoteId: bigint | null;
  entryBasisId: bigint | null;
  tokenUnits: number | null;
  entryObservedAt: Date | null;
  entryAt: Date;
};

export async function openSignalsByKey(args: {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
}): Promise<OpenSignalRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, pair_id, side, size_usd, threshold_bps, entry_edge_bps,
            entry_token_price_usd, entry_base_price_usd, entry_quote_id, entry_basis_id,
            token_units, entry_observed_at, entry_at
     FROM paper_signals
     WHERE pair_id = $1 AND side = $2 AND size_usd = $3 AND exit_at IS NULL
     ORDER BY entry_at ASC`,
    [args.pairId, args.side, args.sizeUsd],
  );
  return rows.map((r: any) => ({
    id: BigInt(r.id),
    pairId: r.pair_id,
    side: r.side,
    sizeUsd: Number(r.size_usd),
    thresholdBps: Number(r.threshold_bps),
    entryEdgeBps: Number(r.entry_edge_bps),
    entryTokenPriceUsd:
      r.entry_token_price_usd == null ? null : Number(r.entry_token_price_usd),
    entryBasePriceUsd:
      r.entry_base_price_usd == null ? null : Number(r.entry_base_price_usd),
    entryQuoteId: r.entry_quote_id == null ? null : BigInt(r.entry_quote_id),
    entryBasisId: r.entry_basis_id == null ? null : BigInt(r.entry_basis_id),
    tokenUnits: r.token_units == null ? null : Number(r.token_units),
    entryObservedAt: r.entry_observed_at,
    entryAt: r.entry_at,
  }));
}

export type ClosedSignalRow = OpenSignalRow & {
  exitAt: Date;
  exitEdgeBps: number;
  exitSide: PairDirection | null;
  exitTokenPriceUsd: number | null;
  exitBasePriceUsd: number | null;
  exitQuoteId: bigint | null;
  exitBasisId: bigint | null;
  exitObservedAt: Date | null;
  exitReason: string | null;
  pnlUsd: number;
  outcome: string;
};

export async function closedSignals(args: {
  pairId: string;
  sinceMs: number;
}): Promise<ClosedSignalRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, pair_id, side, size_usd, threshold_bps, entry_edge_bps, entry_at,
            entry_token_price_usd, entry_base_price_usd, entry_quote_id, entry_basis_id,
            token_units, entry_observed_at,
            exit_at, exit_edge_bps, exit_side, exit_token_price_usd,
            exit_base_price_usd, exit_quote_id, exit_basis_id, exit_observed_at,
            exit_reason, pnl_usd, outcome
     FROM paper_signals
     WHERE pair_id = $1
       AND exit_at IS NOT NULL
       AND exit_at >= to_timestamp($2 / 1000.0)
     ORDER BY exit_at ASC`,
    [args.pairId, args.sinceMs],
  );
  return rows.map((r: any) => ({
    id: BigInt(r.id),
    pairId: r.pair_id,
    side: r.side,
    sizeUsd: Number(r.size_usd),
    thresholdBps: Number(r.threshold_bps),
    entryEdgeBps: Number(r.entry_edge_bps),
    entryTokenPriceUsd:
      r.entry_token_price_usd == null ? null : Number(r.entry_token_price_usd),
    entryBasePriceUsd:
      r.entry_base_price_usd == null ? null : Number(r.entry_base_price_usd),
    entryQuoteId: r.entry_quote_id == null ? null : BigInt(r.entry_quote_id),
    entryBasisId: r.entry_basis_id == null ? null : BigInt(r.entry_basis_id),
    tokenUnits: r.token_units == null ? null : Number(r.token_units),
    entryObservedAt: r.entry_observed_at,
    entryAt: r.entry_at,
    exitAt: r.exit_at,
    exitEdgeBps: Number(r.exit_edge_bps),
    exitSide: r.exit_side,
    exitTokenPriceUsd:
      r.exit_token_price_usd == null ? null : Number(r.exit_token_price_usd),
    exitBasePriceUsd:
      r.exit_base_price_usd == null ? null : Number(r.exit_base_price_usd),
    exitQuoteId: r.exit_quote_id == null ? null : BigInt(r.exit_quote_id),
    exitBasisId: r.exit_basis_id == null ? null : BigInt(r.exit_basis_id),
    exitObservedAt: r.exit_observed_at,
    exitReason: r.exit_reason,
    pnlUsd: Number(r.pnl_usd),
    outcome: r.outcome,
  }));
}
