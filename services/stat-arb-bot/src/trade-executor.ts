import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createSolanaRpc,
  decompileTransactionMessageFetchingLookupTables,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  signTransaction as signKitTransaction,
  type Address,
  type CompilableTransactionMessage,
  type KeyPairSigner,
  type Signature,
  type Transaction,
} from "@solana/kit";
import { atomicToUi } from "@sotama/market-core";
import type { PairConfig, PairDirection } from "@sotama/market-core";
import { insertTradeExecution } from "@sotama/db";
import type { TradeExecutionStatus } from "@sotama/db";
import { JupiterClient, type OrderResult } from "./jupiter-client";

export type TradeExecutionMode =
  | "paper"
  | "jupiter-dry-run"
  | "jupiter-managed"
  | "helius-sender";

export type TradeExecutionResult = {
  mode: TradeExecutionMode;
  status: TradeExecutionStatus | "cooldown" | "disabled";
  executionId: bigint | null;
  expectedOutAmount: bigint | null;
  actualOutAmount: bigint | null;
  message: string | null;
};

export type TradeExecutionInput = {
  action: "open" | "close";
  pair: PairConfig;
  side: PairDirection;
  sizeUsd: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  edgeBps: number;
  inputAmount: bigint;
  signalId?: bigint | null;
  dedupeKey: string;
};

type FetchImpl = typeof fetch;
type OkOrder = Extract<OrderResult, { status: "ok" }>;

const TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");

export class TradeExecutor {
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly senderRpc: ReturnType<typeof createSolanaRpc> | null;
  private readonly fetchImpl: FetchImpl;
  private nextTipIndex = 0;

  constructor(
    private readonly cfg: {
      mode: TradeExecutionMode;
      taker?: string;
      signer?: KeyPairSigner | null;
      minIntervalMs: number;
      retainRaw: boolean;
      heliusRpcUrl?: string;
      heliusSenderUrl: string;
      heliusSenderTipLamports: number;
      senderExcludeRouters: string;
      confirmationTimeoutMs: number;
      fetchImpl?: FetchImpl;
    },
    private readonly jupiter: JupiterClient,
  ) {
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as FetchImpl);
    if (cfg.mode === "helius-sender" && !cfg.heliusRpcUrl) {
      throw new Error("helius-sender requires HELIUS_RPC_URL");
    }
    this.senderRpc =
      cfg.mode === "helius-sender" && cfg.heliusRpcUrl
        ? createSolanaRpc(cfg.heliusRpcUrl)
        : null;
  }

  get enabled(): boolean {
    return this.cfg.mode !== "paper";
  }

  get mode(): TradeExecutionMode {
    return this.cfg.mode;
  }

  async execute(args: TradeExecutionInput): Promise<TradeExecutionResult> {
    if (!this.enabled) return this.disabled();

    const now = Date.now();
    const last = this.lastAttemptAt.get(args.dedupeKey) ?? 0;
    if (now - last < this.cfg.minIntervalMs) {
      return {
        mode: this.cfg.mode,
        status: "cooldown",
        executionId: null,
        expectedOutAmount: null,
        actualOutAmount: null,
        message: "execution cooldown active",
      };
    }
    this.lastAttemptAt.set(args.dedupeKey, now);

    const requestStartedAt = new Date(now);
    const inputMint =
      args.side === "buy_tokenized" ? args.pair.quote.mint : args.pair.tokenized.mint;
    const outputMint =
      args.side === "buy_tokenized" ? args.pair.tokenized.mint : args.pair.quote.mint;
    const order = await this.jupiter.order({
      inputMint,
      outputMint,
      amount: args.inputAmount,
      slippageBps: args.pair.slippageBps,
      taker: this.cfg.taker,
      excludeRouters:
        this.cfg.mode === "helius-sender" ? this.cfg.senderExcludeRouters || undefined : undefined,
    });
    const orderResponseAt = new Date();

    if (order.status !== "ok") {
      return this.recordTerminal({
        args,
        inputMint,
        outputMint,
        requestStartedAt,
        orderResponseAt,
        order,
        status: order.status === "rate_limited" ? "skipped" : "error",
        expectedOutAmount: null,
        actualOutAmount: null,
        message:
          order.status === "rate_limited"
            ? "Jupiter execution order was rate-limited"
            : order.message,
      });
    }

    if (!order.transaction || !order.requestId) {
      return this.recordTerminal({
        args,
        inputMint,
        outputMint,
        requestStartedAt,
        orderResponseAt,
        order,
        status: "error",
        expectedOutAmount: order.outAmount,
        actualOutAmount: null,
        message: "Jupiter order did not return transaction/requestId",
      });
    }

    if (this.cfg.mode === "jupiter-dry-run") {
      return this.recordTerminal({
        args,
        inputMint,
        outputMint,
        requestStartedAt,
        orderResponseAt,
        order,
        status: "dry_run",
        expectedOutAmount: order.outAmount,
        actualOutAmount: null,
        message: null,
      });
    }

    const signer = this.requiredSigner();
    if (this.cfg.mode === "jupiter-managed") {
      return this.executeViaJupiter({
        args,
        inputMint,
        outputMint,
        requestStartedAt,
        orderResponseAt,
        order,
        signer,
      });
    }

    return this.executeViaHeliusSender({
      args,
      inputMint,
      outputMint,
      requestStartedAt,
      orderResponseAt,
      order,
      signer,
    });
  }

  outputTokenUnits(result: TradeExecutionResult, pair: PairConfig): number | null {
    const amount = result.actualOutAmount ?? result.expectedOutAmount;
    if (amount == null) return null;
    return atomicToUi(amount, pair.tokenized.decimals);
  }

  private async executeViaJupiter(input: {
    args: TradeExecutionInput;
    inputMint: string;
    outputMint: string;
    requestStartedAt: Date;
    orderResponseAt: Date;
    order: OkOrder;
    signer: KeyPairSigner;
  }): Promise<TradeExecutionResult> {
    let signed: { signedTransaction: string; signMs: number };
    try {
      signed = await signWireTransaction(input.order.transaction!, input.signer);
    } catch (e: any) {
      return this.recordTerminal({
        ...input,
        status: "error",
        expectedOutAmount: input.order.outAmount,
        actualOutAmount: null,
        message: String(e?.message ?? e),
      });
    }

    const execute = await this.jupiter.execute({
      signedTransaction: signed.signedTransaction,
      requestId: input.order.requestId!,
      lastValidBlockHeight: input.order.lastValidBlockHeight,
    });
    const executeResponseAt = new Date();
    const ok = execute.status === "ok" && execute.swapStatus === "Success";
    const status: TradeExecutionStatus =
      execute.status === "ok" ? (ok ? "success" : "failed")
      : execute.status === "rate_limited" ? "skipped"
      : "error";
    const actualOutAmount = execute.status === "ok" ? execute.outputAmountResult : null;
    const message =
      execute.status === "ok"
        ? execute.error
        : execute.status === "rate_limited"
          ? "Jupiter execute was rate-limited"
          : execute.message;
    const executionId = await this.record({
      args: input.args,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      requestStartedAt: input.requestStartedAt,
      orderResponseAt: input.orderResponseAt,
      executeResponseAt,
      status,
      order: input.order,
      expectedOutAmount: input.order.outAmount,
      actualOutAmount,
      signMs: signed.signMs,
      executeRequestMs: execute.requestMs,
      signature: execute.status === "ok" ? execute.signature : null,
      slot: execute.status === "ok" ? execute.slot : null,
      errorCode: execute.status === "ok" ? execute.code : null,
      errorMessage: message,
      rawExecute: execute.status === "ok" ? execute.raw : null,
    });
    return {
      mode: this.cfg.mode,
      status,
      executionId,
      expectedOutAmount: input.order.outAmount,
      actualOutAmount,
      message,
    };
  }

  private async executeViaHeliusSender(input: {
    args: TradeExecutionInput;
    inputMint: string;
    outputMint: string;
    requestStartedAt: Date;
    orderResponseAt: Date;
    order: OkOrder;
    signer: KeyPairSigner;
  }): Promise<TradeExecutionResult> {
    let prepared: { signedTransaction: string; prepareMs: number; signMs: number };
    try {
      prepared = await this.prepareSenderTransaction(
        input.order.transaction!,
        input.signer,
        input.order.lastValidBlockHeight,
      );
    } catch (e: any) {
      return this.recordTerminal({
        ...input,
        status: "error",
        expectedOutAmount: input.order.outAmount,
        actualOutAmount: null,
        message: String(e?.message ?? e),
      });
    }

    const sent = await this.sendWithSender(prepared.signedTransaction);
    const executeResponseAt = new Date();
    const confirmed =
      sent.signature && this.senderRpc && this.cfg.confirmationTimeoutMs > 0
        ? await this.waitForConfirmation(sent.signature)
        : null;
    const status: TradeExecutionStatus =
      sent.status === "ok" ? (confirmed?.ok === true ? "success" : "submitted") : "error";
    const message = sent.message ?? confirmed?.message ?? null;
    const executionId = await this.record({
      args: input.args,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      requestStartedAt: input.requestStartedAt,
      orderResponseAt: input.orderResponseAt,
      executeResponseAt,
      status,
      order: input.order,
      expectedOutAmount: input.order.outAmount,
      actualOutAmount: null,
      signMs: prepared.signMs,
      senderPrepareMs: prepared.prepareMs,
      executeRequestMs: sent.requestMs,
      signature: sent.signature,
      errorMessage: message,
      rawExecute: sent.raw,
    });
    return {
      mode: this.cfg.mode,
      status,
      executionId,
      expectedOutAmount: input.order.outAmount,
      actualOutAmount: null,
      message,
    };
  }

  private async prepareSenderTransaction(
    transactionBase64: string,
    signer: KeyPairSigner,
    lastValidBlockHeight?: string | null,
  ): Promise<{ signedTransaction: string; prepareMs: number; signMs: number }> {
    if (!this.senderRpc) {
      throw new Error("helius-sender requires HELIUS_RPC_URL for lookup tables and confirmation");
    }

    const t0 = Date.now();
    const transaction = decodeWireTransaction(transactionBase64);
    const compiledMessage = getCompiledTransactionMessageDecoder().decode(
      transaction.messageBytes,
    );
    const parsedLastValidBlockHeight = parseLastValidBlockHeight(lastValidBlockHeight);
    const decompiled = await decompileTransactionMessageFetchingLookupTables(
      compiledMessage,
      this.senderRpc,
      parsedLastValidBlockHeight == null
        ? undefined
        : { lastValidBlockHeight: parsedLastValidBlockHeight },
    );
    const withTip = appendTransactionMessageInstruction(
      createSystemTransferInstruction({
        source: signer.address,
        destination: address(this.nextTipAccount()),
        lamports: this.cfg.heliusSenderTipLamports,
      }),
      decompiled,
    );

    const signStart = Date.now();
    const signed = await signKitTransaction(
      [signer.keyPair],
      compileTransaction(withTip as CompilableTransactionMessage),
    );
    return {
      signedTransaction: getBase64EncodedWireTransaction(signed),
      prepareMs: signStart - t0,
      signMs: Date.now() - signStart,
    };
  }

  private async sendWithSender(signedTransaction: string): Promise<{
    status: "ok" | "error";
    signature: string | null;
    requestMs: number;
    message: string | null;
    raw: unknown;
  }> {
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(this.cfg.heliusSenderUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now().toString(),
          method: "sendTransaction",
          params: [
            signedTransaction,
            { encoding: "base64", skipPreflight: true, maxRetries: 0 },
          ],
        }),
      });
      const requestMs = Date.now() - t0;
      const json = (await res.json()) as {
        result?: string;
        error?: { message?: string } | string;
      } & Record<string, unknown>;
      if (!res.ok || json.error) {
        const message =
          typeof json.error === "string"
            ? json.error
            : json.error?.message ?? `HTTP ${res.status}`;
        return { status: "error", signature: null, requestMs, message, raw: json };
      }
      return {
        status: "ok",
        signature: typeof json.result === "string" ? json.result : null,
        requestMs,
        message: null,
        raw: json,
      };
    } catch (e: any) {
      return {
        status: "error",
        signature: null,
        requestMs: Date.now() - t0,
        message: String(e?.message ?? e),
        raw: null,
      };
    }
  }

  private async waitForConfirmation(signature: string): Promise<{ ok: boolean; message: string | null }> {
    if (!this.senderRpc) return { ok: false, message: "missing Helius RPC connection" };
    const deadline = Date.now() + this.cfg.confirmationTimeoutMs;
    while (Date.now() < deadline) {
      const { value } = await this.senderRpc
        .getSignatureStatuses([signature as Signature])
        .send();
      const status = value[0];
      if (status?.err) return { ok: false, message: JSON.stringify(status.err) };
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return { ok: true, message: null };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, message: "confirmation timeout" };
  }

  private async recordTerminal(input: {
    args: TradeExecutionInput;
    inputMint: string;
    outputMint: string;
    requestStartedAt: Date;
    orderResponseAt: Date;
    order: OrderResult;
    status: TradeExecutionStatus;
    expectedOutAmount: bigint | null;
    actualOutAmount: bigint | null;
    message: string | null;
  }): Promise<TradeExecutionResult> {
    const executionId = await this.record({
      args: input.args,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      requestStartedAt: input.requestStartedAt,
      orderResponseAt: input.orderResponseAt,
      status: input.status,
      order: input.order,
      expectedOutAmount: input.expectedOutAmount,
      actualOutAmount: input.actualOutAmount,
      errorMessage: input.message,
    });
    return {
      mode: this.cfg.mode,
      status: input.status,
      executionId,
      expectedOutAmount: input.expectedOutAmount,
      actualOutAmount: input.actualOutAmount,
      message: input.message,
    };
  }

  private async record(input: {
    args: TradeExecutionInput;
    inputMint: string;
    outputMint: string;
    requestStartedAt: Date;
    orderResponseAt?: Date | null;
    executeResponseAt?: Date | null;
    status: TradeExecutionStatus;
    order?: OrderResult;
    expectedOutAmount?: bigint | null;
    actualOutAmount?: bigint | null;
    signMs?: number | null;
    senderPrepareMs?: number | null;
    executeRequestMs?: number | null;
    signature?: string | null;
    slot?: string | null;
    errorCode?: number | null;
    errorMessage?: string | null;
    rawExecute?: unknown;
  }): Promise<bigint> {
    const order = input.order?.status === "ok" ? input.order : null;
    return insertTradeExecution({
      pairId: input.args.pair.id,
      signalId: input.args.signalId ?? null,
      action: input.args.action,
      side: input.args.side,
      sizeUsd: input.args.sizeUsd,
      mode: this.cfg.mode,
      status: input.status,
      edgeBps: input.args.edgeBps,
      basePriceUsd: input.args.basePriceUsd,
      tokenPriceUsd: input.args.tokenPriceUsd,
      inMint: input.inputMint,
      outMint: input.outputMint,
      inAmount: input.args.inputAmount,
      expectedOutAmount: input.expectedOutAmount ?? order?.outAmount ?? null,
      actualOutAmount: input.actualOutAmount ?? null,
      router: order?.router ?? null,
      orderRequestId: order?.requestId ?? null,
      orderQuoteId: order?.quoteId ?? null,
      signature: input.signature ?? null,
      slot: input.slot ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      orderRequestMs: input.order?.requestMs ?? null,
      signMs: input.signMs ?? null,
      senderPrepareMs: input.senderPrepareMs ?? null,
      executeRequestMs: input.executeRequestMs ?? null,
      requestStartedAt: input.requestStartedAt,
      orderResponseAt: input.orderResponseAt ?? null,
      executeResponseAt: input.executeResponseAt ?? null,
      rawOrder: this.cfg.retainRaw ? order?.raw ?? null : null,
      rawExecute: this.cfg.retainRaw ? input.rawExecute ?? null : null,
    });
  }

  private nextTipAccount(): string {
    const account = TIP_ACCOUNTS[this.nextTipIndex % TIP_ACCOUNTS.length]!;
    this.nextTipIndex += 1;
    return account;
  }

  private requiredSigner(): KeyPairSigner {
    if (!this.cfg.signer) throw new Error(`${this.cfg.mode} requires a signer`);
    return this.cfg.signer;
  }

  private disabled(): TradeExecutionResult {
    return {
      mode: "paper",
      status: "disabled",
      executionId: null,
      expectedOutAmount: null,
      actualOutAmount: null,
      message: null,
    };
  }
}

async function signWireTransaction(
  transactionBase64: string,
  signer: KeyPairSigner,
): Promise<{ signedTransaction: string; signMs: number }> {
  const t0 = Date.now();
  const transaction = decodeWireTransaction(transactionBase64);
  const signed = await signKitTransaction([signer.keyPair], transaction);
  return {
    signedTransaction: getBase64EncodedWireTransaction(signed),
    signMs: Date.now() - t0,
  };
}

function decodeWireTransaction(transactionBase64: string): Transaction {
  return getTransactionDecoder().decode(Buffer.from(transactionBase64, "base64"));
}

function parseLastValidBlockHeight(value?: string | null): bigint | undefined {
  if (!value) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function createSystemTransferInstruction(args: {
  source: Address;
  destination: Address;
  lamports: number;
}) {
  if (!Number.isSafeInteger(args.lamports) || args.lamports < 0) {
    throw new Error(`invalid Helius sender tip lamports: ${args.lamports}`);
  }
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(args.lamports), true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: args.source, role: AccountRole.WRITABLE_SIGNER },
      { address: args.destination, role: AccountRole.WRITABLE },
    ],
    data,
  };
}
