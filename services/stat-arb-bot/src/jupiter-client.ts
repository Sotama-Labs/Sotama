export type OrderRequest = {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps?: number;
  taker?: string;
  excludeRouters?: string;
};

export type OrderResult =
  | {
      status: "ok";
      outAmount: bigint;
      inAmount: bigint;
      priceImpactPct: number | null;
      router: string | null;
      quoteId: string | null;
      requestId: string | null;
      transaction: string | null;
      lastValidBlockHeight: string | null;
      mode: string | null;
      expiresAt: Date | null;
      contextSlot: number | null;
      requestMs: number;
      raw: unknown;
    }
  | { status: "rate_limited"; requestMs: number }
  | { status: "error"; requestMs: number; message: string };

export type ExecuteResult =
  | {
      status: "ok";
      swapStatus: "Success" | "Failed" | string;
      signature: string | null;
      slot: string | null;
      code: number | null;
      inputAmountResult: bigint | null;
      outputAmountResult: bigint | null;
      error: string | null;
      requestMs: number;
      raw: unknown;
    }
  | { status: "rate_limited"; requestMs: number }
  | { status: "error"; requestMs: number; message: string };

type FetchImpl = typeof fetch;

const ORDER_REQUEST_TIMEOUT_MS = 4000;
const EXECUTE_REQUEST_TIMEOUT_MS = 8000;

/** Thin wrapper around Jupiter's `/swap/v2/order` endpoint.
 *  Pure HTTP — no rate limiting here; the QuoteScheduler owns the budget. */
export class JupiterClient {
  private readonly fetchImpl: FetchImpl;

  constructor(
    private readonly cfg: {
      baseUrl: string;
      apiKey?: string;
      fetchImpl?: FetchImpl;
    },
  ) {
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as FetchImpl);
  }

  async order(req: OrderRequest): Promise<OrderResult> {
    const t0 = Date.now();
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;

    const params = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount.toString(),
    });
    if (req.slippageBps != null) params.set("slippageBps", req.slippageBps.toString());
    if (req.taker) params.set("taker", req.taker);
    if (req.excludeRouters) params.set("excludeRouters", req.excludeRouters);

    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/swap/v2/order?${params}`, {
        headers,
        signal: AbortSignal.timeout(ORDER_REQUEST_TIMEOUT_MS),
      });
      const requestMs = Date.now() - t0;
      if (res.status === 429) return { status: "rate_limited", requestMs };
      if (!res.ok) {
        return { status: "error", requestMs, message: `HTTP ${res.status}` };
      }

      const json = (await res.json()) as {
        outAmount?: string;
        inAmount?: string;
        transaction?: string | null;
        priceImpactPct?: string | number;
        priceImpact?: string | number;
        router?: string;
        quoteId?: string;
        requestId?: string;
        id?: string;
        lastValidBlockHeight?: string | number;
        mode?: string;
        expiresAt?: string | number;
        expireAt?: string | number;
        contextSlot?: string | number;
      } & Record<string, unknown>;

      if (!json.outAmount || !json.inAmount) {
        return { status: "error", requestMs, message: "missing outAmount/inAmount" };
      }

      const impact = firstFiniteNumber(json.priceImpact, json.priceImpactPct);
      return {
        status: "ok",
        outAmount: BigInt(json.outAmount),
        inAmount: BigInt(json.inAmount),
        priceImpactPct: impact == null || Number.isNaN(impact) ? null : impact,
        router: json.router ?? null,
        quoteId: firstString(json.quoteId, json.id, json.requestId),
        requestId: firstString(json.requestId),
        transaction:
          typeof json.transaction === "string" && json.transaction.length > 0
            ? json.transaction
            : null,
        lastValidBlockHeight:
          json.lastValidBlockHeight == null ? null : String(json.lastValidBlockHeight),
        mode: typeof json.mode === "string" ? json.mode : null,
        expiresAt: parseDate(json.expiresAt ?? json.expireAt),
        contextSlot: parseFiniteNumber(json.contextSlot),
        requestMs,
        raw: json,
      };
    } catch (e: any) {
      return {
        status: "error",
        requestMs: Date.now() - t0,
        message: String(e?.message ?? e),
      };
    }
  }

  async execute(req: {
    signedTransaction: string;
    requestId: string;
    lastValidBlockHeight?: string | null;
  }): Promise<ExecuteResult> {
    const t0 = Date.now();
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (this.cfg.apiKey) headers["x-api-key"] = this.cfg.apiKey;

    const body: Record<string, string> = {
      signedTransaction: req.signedTransaction,
      requestId: req.requestId,
    };
    if (req.lastValidBlockHeight) body.lastValidBlockHeight = req.lastValidBlockHeight;

    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/swap/v2/execute`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(EXECUTE_REQUEST_TIMEOUT_MS),
      });
      const requestMs = Date.now() - t0;
      if (res.status === 429) return { status: "rate_limited", requestMs };
      if (!res.ok) {
        return { status: "error", requestMs, message: `HTTP ${res.status}` };
      }

      const json = (await res.json()) as {
        status?: string;
        signature?: string;
        slot?: string | number;
        code?: string | number;
        inputAmountResult?: string;
        outputAmountResult?: string;
        totalOutputAmount?: string;
        error?: string;
      } & Record<string, unknown>;

      return {
        status: "ok",
        swapStatus: json.status ?? (json.error ? "Failed" : "Success"),
        signature: firstString(json.signature),
        slot: json.slot == null ? null : String(json.slot),
        code: parseFiniteNumber(json.code),
        inputAmountResult: parseOptionalBigInt(json.inputAmountResult),
        outputAmountResult: parseOptionalBigInt(json.outputAmountResult ?? json.totalOutputAmount),
        error: firstString(json.error),
        requestMs,
        raw: json,
      };
    } catch (e: any) {
      return {
        status: "error",
        requestMs: Date.now() - t0,
        message: String(e?.message ?? e),
      };
    }
  }
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = parseFiniteNumber(value);
    if (n != null) return n;
  }
  return null;
}

function parseOptionalBigInt(value: unknown): bigint | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | null {
  if (value == null) return null;
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d : null;
  }
  return null;
}
