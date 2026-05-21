import { getPool } from "./index";
import type { PairDirection } from "@sotama/market-core";

export type TradeExecutionAction = "open" | "close";
export type TradeExecutionStatus =
  | "dry_run"
  | "submitted"
  | "success"
  | "failed"
  | "error"
  | "skipped";

export type TradeExecutionInsert = {
  pairId: string;
  signalId?: bigint | null;
  action: TradeExecutionAction;
  side: PairDirection;
  sizeUsd: number;
  mode: string;
  status: TradeExecutionStatus;
  edgeBps: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  inMint: string;
  outMint: string;
  inAmount: bigint;
  expectedOutAmount?: bigint | null;
  actualOutAmount?: bigint | null;
  router?: string | null;
  orderRequestId?: string | null;
  orderQuoteId?: string | null;
  signature?: string | null;
  slot?: string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
  orderRequestMs?: number | null;
  signMs?: number | null;
  senderPrepareMs?: number | null;
  executeRequestMs?: number | null;
  requestStartedAt: Date;
  orderResponseAt?: Date | null;
  executeResponseAt?: Date | null;
  rawOrder?: unknown;
  rawExecute?: unknown;
};

export async function insertTradeExecution(row: TradeExecutionInsert): Promise<bigint> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO trade_executions
       (pair_id, signal_id, action, side, size_usd, mode, status,
        edge_bps, base_price_usd, token_price_usd, in_mint, out_mint,
        in_amount, expected_out_amount, actual_out_amount, router,
        order_request_id, order_quote_id, signature, slot, error_code,
        error_message, order_request_ms, sign_ms, sender_prepare_ms,
        execute_request_ms, request_started_at, order_response_at,
        execute_response_at, raw_order, raw_execute)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
        $17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
     RETURNING id`,
    [
      row.pairId,
      row.signalId == null ? null : row.signalId.toString(),
      row.action,
      row.side,
      row.sizeUsd,
      row.mode,
      row.status,
      row.edgeBps,
      row.basePriceUsd,
      row.tokenPriceUsd,
      row.inMint,
      row.outMint,
      row.inAmount.toString(),
      row.expectedOutAmount == null ? null : row.expectedOutAmount.toString(),
      row.actualOutAmount == null ? null : row.actualOutAmount.toString(),
      row.router ?? null,
      row.orderRequestId ?? null,
      row.orderQuoteId ?? null,
      row.signature ?? null,
      row.slot ?? null,
      row.errorCode ?? null,
      row.errorMessage ?? null,
      row.orderRequestMs ?? null,
      row.signMs ?? null,
      row.senderPrepareMs ?? null,
      row.executeRequestMs ?? null,
      row.requestStartedAt,
      row.orderResponseAt ?? null,
      row.executeResponseAt ?? null,
      row.rawOrder == null ? null : JSON.stringify(row.rawOrder),
      row.rawExecute == null ? null : JSON.stringify(row.rawExecute),
    ],
  );
  return BigInt(rows[0]!.id);
}

export async function attachTradeExecutionSignal(args: {
  executionId: bigint;
  signalId: bigint;
}): Promise<void> {
  await getPool().query(
    `UPDATE trade_executions SET signal_id = $2 WHERE id = $1`,
    [args.executionId.toString(), args.signalId.toString()],
  );
}
