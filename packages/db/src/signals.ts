import { getPool } from "./index";
import type { PairDirection, QuoteQualityStatus } from "@sotama/market-core";

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
  entryQualityStatus: QuoteQualityStatus;
  entryQualityReason: string;
  entryAt: Date;
  executionMode?: string;
  entryExecutionId?: bigint | null;
};

export async function openSignal(row: OpenSignalInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO paper_signals
       (pair_id, side, entry_side, size_usd, threshold_bps, entry_edge_bps,
        entry_token_price_usd, entry_base_price_usd, entry_quote_id, entry_basis_id,
        token_units, entry_observed_at, entry_quality_status, entry_quality_reason,
        entry_at, outcome, execution_mode, entry_execution_id)
     VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'open',$15,$16)
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
      row.entryQualityStatus,
      row.entryQualityReason,
      row.entryAt,
      row.executionMode ?? "paper",
      row.entryExecutionId == null ? null : row.entryExecutionId.toString(),
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
  exitQualityStatus: QuoteQualityStatus;
  exitQualityReason: string;
  exitReason: "converged" | "stale";
  pnlUsd: number;
  outcome: "closed_win" | "closed_loss" | "closed_flat" | "closed_stale";
  exitAt: Date;
  exitExecutionId?: bigint | null;
};

export async function closeSignal(args: CloseSignalArgs): Promise<void> {
  await getPool().query(
    `UPDATE paper_signals
     SET exit_at = $2, exit_edge_bps = $3, pnl_usd = $4, outcome = $5,
         exit_side = $6, exit_token_price_usd = $7, exit_base_price_usd = $8,
         exit_quote_id = $9, exit_basis_id = $10, exit_observed_at = $11,
         exit_quality_status = $12, exit_quality_reason = $13, exit_reason = $14,
         exit_execution_id = $15
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
      args.exitQualityStatus,
      args.exitQualityReason,
      args.exitReason,
      args.exitExecutionId == null ? null : args.exitExecutionId.toString(),
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
  entryQualityStatus: QuoteQualityStatus;
  entryQualityReason: string;
  executionMode: string;
  entryExecutionId: bigint | null;
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
            token_units, entry_observed_at, entry_quality_status, entry_quality_reason,
            execution_mode, entry_execution_id, entry_at
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
    entryQualityStatus: r.entry_quality_status ?? "LIVE_ELIGIBLE",
    entryQualityReason: r.entry_quality_reason ?? "legacy signal before quality gate",
    executionMode: r.execution_mode ?? "paper",
    entryExecutionId: r.entry_execution_id == null ? null : BigInt(r.entry_execution_id),
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
  exitQualityStatus: QuoteQualityStatus | null;
  exitQualityReason: string | null;
  exitReason: string | null;
  exitExecutionId: bigint | null;
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
            token_units, entry_observed_at, entry_quality_status, entry_quality_reason,
            execution_mode, entry_execution_id,
            exit_at, exit_edge_bps, exit_side, exit_token_price_usd,
            exit_base_price_usd, exit_quote_id, exit_basis_id, exit_observed_at,
            exit_quality_status, exit_quality_reason, exit_reason, exit_execution_id,
            pnl_usd, outcome
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
    entryQualityStatus: r.entry_quality_status ?? "LIVE_ELIGIBLE",
    entryQualityReason: r.entry_quality_reason ?? "legacy signal before quality gate",
    executionMode: r.execution_mode ?? "paper",
    entryExecutionId: r.entry_execution_id == null ? null : BigInt(r.entry_execution_id),
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
    exitQualityStatus: r.exit_quality_status,
    exitQualityReason: r.exit_quality_reason,
    exitReason: r.exit_reason,
    exitExecutionId: r.exit_execution_id == null ? null : BigInt(r.exit_execution_id),
    pnlUsd: Number(r.pnl_usd),
    outcome: r.outcome,
  }));
}
