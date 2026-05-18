import { getPool } from "./index";
import type { PairDirection } from "@sotama/market-core";

export type OpenSignalInsert = {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  thresholdBps: number;
  entryEdgeBps: number;
  entryAt: Date;
};

export async function openSignal(row: OpenSignalInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO paper_signals
       (pair_id, side, size_usd, threshold_bps, entry_edge_bps, entry_at, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,'open')
     RETURNING id`,
    [row.pairId, row.side, row.sizeUsd, row.thresholdBps, row.entryEdgeBps, row.entryAt],
  );
  return BigInt(rows[0]!.id);
}

export type CloseSignalArgs = {
  id: bigint;
  exitEdgeBps: number;
  pnlUsd: number;
  outcome: "closed_win" | "closed_loss" | "closed_flat" | "closed_stale";
  exitAt: Date;
};

export async function closeSignal(args: CloseSignalArgs): Promise<void> {
  await getPool().query(
    `UPDATE paper_signals
     SET exit_at = $2, exit_edge_bps = $3, pnl_usd = $4, outcome = $5
     WHERE id = $1`,
    [args.id.toString(), args.exitAt, args.exitEdgeBps, args.pnlUsd, args.outcome],
  );
}

export type OpenSignalRow = {
  id: bigint;
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  thresholdBps: number;
  entryEdgeBps: number;
  entryAt: Date;
};

export async function openSignalsByKey(args: {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
}): Promise<OpenSignalRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, pair_id, side, size_usd, threshold_bps, entry_edge_bps, entry_at
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
    entryAt: r.entry_at,
  }));
}

export type ClosedSignalRow = OpenSignalRow & {
  exitAt: Date;
  exitEdgeBps: number;
  pnlUsd: number;
  outcome: string;
};

export async function closedSignals(args: {
  pairId: string;
  sinceMs: number;
}): Promise<ClosedSignalRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, pair_id, side, size_usd, threshold_bps, entry_edge_bps, entry_at,
            exit_at, exit_edge_bps, pnl_usd, outcome
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
    entryAt: r.entry_at,
    exitAt: r.exit_at,
    exitEdgeBps: Number(r.exit_edge_bps),
    pnlUsd: Number(r.pnl_usd),
    outcome: r.outcome,
  }));
}
