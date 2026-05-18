export type OrderRequest = {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
};

export type OrderResult =
  | {
      status: "ok";
      outAmount: bigint;
      inAmount: bigint;
      priceImpactPct: number | null;
      router: string | null;
      requestMs: number;
      raw: unknown;
    }
  | { status: "rate_limited"; requestMs: number }
  | { status: "error"; requestMs: number; message: string };

type FetchImpl = typeof fetch;

const REQUEST_TIMEOUT_MS = 4000;

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
    const url =
      `${this.cfg.baseUrl}/swap/v2/order` +
      `?inputMint=${encodeURIComponent(req.inputMint)}` +
      `&outputMint=${encodeURIComponent(req.outputMint)}` +
      `&amount=${req.amount.toString()}` +
      `&slippageBps=${req.slippageBps}`;
    try {
      const res = await this.fetchImpl(url, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const requestMs = Date.now() - t0;
      if (res.status === 429) return { status: "rate_limited", requestMs };
      if (!res.ok) {
        return { status: "error", requestMs, message: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as {
        outAmount?: string;
        inAmount?: string;
        priceImpactPct?: string | number;
        router?: string;
      };
      if (!json.outAmount || !json.inAmount) {
        return { status: "error", requestMs, message: "missing outAmount/inAmount" };
      }
      const impact =
        json.priceImpactPct == null
          ? null
          : Number(json.priceImpactPct);
      return {
        status: "ok",
        outAmount: BigInt(json.outAmount),
        inAmount: BigInt(json.inAmount),
        priceImpactPct: impact == null || Number.isNaN(impact) ? null : impact,
        router: json.router ?? null,
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
