import {
  effectiveBuyPriceUsd,
  effectiveSellPriceUsd,
  buyEdgeBps,
  sellEdgeBps,
  netEdgeBps,
} from "@sotama/market-core";
import type { PairConfig, PairDirection } from "@sotama/market-core";
import { insertJupiterQuote, insertBasisObservation } from "@sotama/db";
import type { OrderResult } from "./jupiter-client";

export type CostBps = {
  slippageBufferBps: number;
  landingCostBps: number;
  failureBufferBps: number;
  minProfitBps: number;
};

export type RecordedQuote =
  | {
      status: "ok";
      tokenPriceUsd: number;
      grossBps: number;
      netBps: number;
      basisId: bigint;
    }
  | { status: "rate_limited" | "error" | "stale" };

/** Persists a Jupiter order outcome and the derived basis observation.
 *
 *  Layer-1 compacted storage policy:
 *  - **Success path**: write ONLY `basis_observations` (the time-series of
 *    derived ratios + edges). `jupiter_quotes` is skipped — its `out_amount`
 *    and price are already captured in basis_observations.token_price_usd,
 *    and the raw JSON adds ~1 KB/row of replay data the analytics never read.
 *  - **Error / rate-limited path**: write `jupiter_quotes` with `raw=null`
 *    so http_429s and outages stay diagnosable, without bloating storage.
 *
 *  Total writes per quote: 1 row (basis) on success, 1 row (jupiter_quotes
 *  diagnostic) on failure — down from 3-row (tick + quote + basis) per quote
 *  pre-compaction.
 */
export async function recordQuote(args: {
  pair: PairConfig;
  side: PairDirection;
  sizeUsd: number;
  basePriceUsd: number;
  result: OrderResult;
  costsBps: CostBps;
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

  const basisId = await insertBasisObservation({
    pairId: pair.id,
    side,
    sizeUsd,
    basePriceUsd,
    tokenPriceUsd,
    grossBps,
    netBps,
    tickId: null,
    quoteId: null,
  });

  return { status: "ok", tokenPriceUsd, grossBps, netBps, basisId };
}
