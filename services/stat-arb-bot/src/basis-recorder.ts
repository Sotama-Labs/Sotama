import {
  effectiveBuyPriceUsd,
  effectiveSellPriceUsd,
  buyEdgeBps,
  sellEdgeBps,
  netEdgeBps,
} from "@sotama/market-core";
import type { PairConfig, PairDirection, TimeRegime } from "@sotama/market-core";
import { insertJupiterQuote, insertBasisObservation } from "@sotama/db";
import type { OrderResult } from "./jupiter-client";

export type CostBps = {
  slippageBufferBps: number;
  landingCostBps: number;
  failureBufferBps: number;
  minProfitBps: number;
};

export type ObservationQuality = "live" | "warm" | "stale" | "invalid";

export type QuoteTiming = {
  pythStreamTimestampUs: number;
  pythFeedUpdateTimestampUs: number;
  pythFreshnessLagMs: number;
  quoteRequestStartedAt: Date;
  quoteResponseAt: Date;
  quoteRequestMs: number;
  basisAgeMs: number;
  quality: ObservationQuality;
  timeRegime?: TimeRegime | null;
};

export type RecordedQuote =
  | {
      status: "ok";
      tokenPriceUsd: number;
      grossBps: number;
      netBps: number;
      quoteId: bigint;
      basisId: bigint;
    }
  | { status: "rate_limited" | "error" | "stale" };

/** Persists every successful Jupiter quote with compact structured metadata,
 * then links the derived basis observation to that quote row. Full raw JSON is
 * retained only for sampled successes or meaningful edge events; structured
 * fields remain present for every success so later tuning can explain routes,
 * request latency, and quote IDs without turning Postgres into blob storage. */
export async function recordQuote(args: {
  pair: PairConfig;
  side: PairDirection;
  sizeUsd: number;
  basePriceUsd: number;
  result: OrderResult;
  costsBps: CostBps;
  timing: QuoteTiming;
  successRawSampleRate: number;
}): Promise<RecordedQuote> {
  const { pair, side, sizeUsd, basePriceUsd, result } = args;
  const inMint = side === "buy_tokenized" ? pair.quote.mint : pair.tokenized.mint;
  const outMint = side === "buy_tokenized" ? pair.tokenized.mint : pair.quote.mint;

  if (result.status !== "ok") {
    await insertJupiterQuote({
      pairId: pair.id,
      side,
      sizeUsd,
      router: null,
      inMint,
      outMint,
      inAmount: 0n,
      outAmount: 0n,
      priceImpactPct: null,
      requestMs: result.requestMs,
      status: result.status === "rate_limited" ? "rate_limited" : "error",
      raw: null,
    });
    return { status: result.status === "rate_limited" ? "rate_limited" : "error" };
  }

  let tokenPriceUsd: number;
  if (side === "buy_tokenized") {
    tokenPriceUsd = effectiveBuyPriceUsd({
      inUsd: sizeUsd,
      outAtomic: result.outAmount,
      outDecimals: pair.tokenized.decimals,
    });
  } else {
    tokenPriceUsd = effectiveSellPriceUsd({
      inAtomic: result.inAmount,
      inDecimals: pair.tokenized.decimals,
      outUsdAtomic: result.outAmount,
      outUsdDecimals: pair.quote.decimals,
    });
  }

  const grossBps =
    side === "buy_tokenized"
      ? buyEdgeBps({ basePriceUsd, tokenBuyPriceUsd: tokenPriceUsd })
      : sellEdgeBps({ basePriceUsd, tokenSellPriceUsd: tokenPriceUsd });

  const netBps = netEdgeBps({ grossBps, ...args.costsBps });
  const retainRaw =
    Math.abs(netBps) >= pair.minNetEdgeBps ||
    Math.random() < args.successRawSampleRate;

  const quoteId = await insertJupiterQuote({
    pairId: pair.id,
    side,
    sizeUsd,
    router: result.router,
    inMint,
    outMint,
    inAmount: result.inAmount,
    outAmount: result.outAmount,
    priceImpactPct: result.priceImpactPct,
    quoteId: result.quoteId,
    expiresAt: result.expiresAt,
    contextSlot: result.contextSlot,
    requestMs: result.requestMs,
    status: "ok",
    raw: retainRaw ? result.raw : null,
  });

  const basisId = await insertBasisObservation({
    pairId: pair.id,
    side,
    sizeUsd,
    basePriceUsd,
    tokenPriceUsd,
    grossBps,
    netBps,
    tickId: null,
    quoteId,
    pythStreamTimestampUs: args.timing.pythStreamTimestampUs,
    pythFeedUpdateTimestampUs: args.timing.pythFeedUpdateTimestampUs,
    pythFreshnessLagMs: args.timing.pythFreshnessLagMs,
    quoteRequestStartedAt: args.timing.quoteRequestStartedAt,
    quoteResponseAt: args.timing.quoteResponseAt,
    quoteRequestMs: args.timing.quoteRequestMs,
    basisAgeMs: args.timing.basisAgeMs,
    quality: args.timing.quality,
    timeRegime: args.timing.timeRegime ?? null,
  });

  return { status: "ok", tokenPriceUsd, grossBps, netBps, quoteId, basisId };
}
