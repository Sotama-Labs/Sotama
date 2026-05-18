import type { PairConfig, PairDirection, QuoteQualityStatus } from "@sotama/market-core";
import { openSignal, closeSignal, openSignalsByKey } from "@sotama/db";

/** Spot-only paper-trade lifecycle.
 *
 * `buy_tokenized` may open tokenized inventory when the executable buy edge
 * clears the pair threshold. `sell_tokenized` never opens a synthetic short;
 * it can only close inventory from an earlier paper buy for the same pair and
 * size. PnL is calculated from executable token buy/sell prices, not from the
 * movement of a same-side edge series.
 */
export class SignalEngine {
  constructor(
    private readonly cfg: {
      staleAfterMs: number;
      transactionCostBps: number;
    },
  ) {}

  async onObservation(args: {
    pair: PairConfig;
    side: PairDirection;
    sizeUsd: number;
    basePriceUsd: number;
    tokenPriceUsd: number;
    netEdgeBps: number;
    quoteId: bigint;
    basisId: bigint;
    qualityStatus: QuoteQualityStatus;
    qualityReason: string;
    observedAtMs: number;
    nowMs: number;
  }): Promise<void> {
    if (args.side === "buy_tokenized") {
      await this.maybeOpenSpotInventory(args);
      return;
    }
    await this.maybeCloseSpotInventory(args);
  }

  private async maybeOpenSpotInventory(args: {
    pair: PairConfig;
    sizeUsd: number;
    basePriceUsd: number;
    tokenPriceUsd: number;
    netEdgeBps: number;
    quoteId: bigint;
    basisId: bigint;
    qualityStatus: QuoteQualityStatus;
    qualityReason: string;
    observedAtMs: number;
    nowMs: number;
  }): Promise<void> {
    const { pair, sizeUsd, tokenPriceUsd, netEdgeBps } = args;
    if (!pair.directions.includes("sell_tokenized")) return;
    if (tokenPriceUsd <= 0) return;

    const open = await openSignalsByKey({
      pairId: pair.id,
      side: "buy_tokenized",
      sizeUsd,
    });
    if (open.length > 0 || netEdgeBps < pair.minNetEdgeBps) return;

    await openSignal({
      pairId: pair.id,
      side: "buy_tokenized",
      sizeUsd,
      thresholdBps: pair.minNetEdgeBps,
      entryEdgeBps: netEdgeBps,
      entryTokenPriceUsd: tokenPriceUsd,
      entryBasePriceUsd: args.basePriceUsd,
      entryQuoteId: args.quoteId,
      entryBasisId: args.basisId,
      tokenUnits: sizeUsd / tokenPriceUsd,
      entryObservedAt: new Date(args.observedAtMs),
      entryQualityStatus: args.qualityStatus,
      entryQualityReason: args.qualityReason,
      entryAt: new Date(args.nowMs),
    });
  }

  private async maybeCloseSpotInventory(args: {
    pair: PairConfig;
    sizeUsd: number;
    basePriceUsd: number;
    tokenPriceUsd: number;
    netEdgeBps: number;
    quoteId: bigint;
    basisId: bigint;
    qualityStatus: QuoteQualityStatus;
    qualityReason: string;
    observedAtMs: number;
    nowMs: number;
  }): Promise<void> {
    const open = await openSignalsByKey({
      pairId: args.pair.id,
      side: "buy_tokenized",
      sizeUsd: args.sizeUsd,
    });

    for (const position of open) {
      if (
        position.tokenUnits == null ||
        position.entryTokenPriceUsd == null ||
        position.entryBasePriceUsd == null
      ) {
        continue;
      }

      const ageMs = args.nowMs - position.entryAt.getTime();
      const stale = ageMs >= this.cfg.staleAfterMs;
      const pnlUsd = computeSpotExitPnlUsd({
        sizeUsd: position.sizeUsd,
        tokenUnits: position.tokenUnits,
        exitTokenPriceUsd: args.tokenPriceUsd,
        transactionCostBps: this.cfg.transactionCostBps,
      });
      const converged = pnlUsd >= 0;
      if (!stale && !converged) continue;

      const outcome =
        stale && pnlUsd <= 0.01 ? "closed_stale"
        : pnlUsd > 0.01 ? "closed_win"
        : pnlUsd < -0.01 ? "closed_loss"
        : "closed_flat";

      await closeSignal({
        id: position.id,
        exitEdgeBps: args.netEdgeBps,
        exitSide: "sell_tokenized",
        exitTokenPriceUsd: args.tokenPriceUsd,
        exitBasePriceUsd: args.basePriceUsd,
        exitQuoteId: args.quoteId,
        exitBasisId: args.basisId,
        exitObservedAt: new Date(args.observedAtMs),
        exitQualityStatus: args.qualityStatus,
        exitQualityReason: args.qualityReason,
        exitReason: converged ? "converged" : "stale",
        pnlUsd,
        outcome,
        exitAt: new Date(args.nowMs),
      });
    }
  }
}

export function computeSpotExitPnlUsd(args: {
  sizeUsd: number;
  tokenUnits: number;
  exitTokenPriceUsd: number;
  transactionCostBps: number;
}): number {
  const exitGrossUsd = args.tokenUnits * args.exitTokenPriceUsd;
  const entryCostsUsd = args.sizeUsd * (args.transactionCostBps / 10000);
  const exitCostsUsd = exitGrossUsd * (args.transactionCostBps / 10000);
  return exitGrossUsd - args.sizeUsd - entryCostsUsd - exitCostsUsd;
}
