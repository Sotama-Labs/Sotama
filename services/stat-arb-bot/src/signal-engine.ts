import { uiToAtomic } from "@sotama/market-core";
import type { PairConfig, PairDirection, QuoteQualityStatus } from "@sotama/market-core";
import { attachTradeExecutionSignal, closeSignal, openSignal, openSignalsByKey } from "@sotama/db";
import type { TradeExecutionResult, TradeExecutor } from "./trade-executor";

/** Spot-only paper-trade lifecycle.
 *
 * `buy_tokenized` may open tokenized inventory when the executable buy edge
 * clears the pair threshold. `sell_tokenized` never opens a synthetic short;
 * it can only close inventory from an earlier buy for the same pair and size.
 * In live execution modes, a close can only use inventory created by a
 * successful live entry execution.
 */
export class SignalEngine {
  constructor(
    private readonly cfg: {
      staleAfterMs: number;
      transactionCostBps: number;
      executor?: TradeExecutor;
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

    const execution = await this.executeOpen(args);
    if (this.requiresLiveSuccess() && execution?.status !== "success") return;

    const executedTokenUnits =
      execution == null ? null : this.cfg.executor?.outputTokenUnits(execution, pair) ?? null;
    const signalId = await openSignal({
      pairId: pair.id,
      side: "buy_tokenized",
      sizeUsd,
      thresholdBps: pair.minNetEdgeBps,
      entryEdgeBps: netEdgeBps,
      entryTokenPriceUsd: tokenPriceUsd,
      entryBasePriceUsd: args.basePriceUsd,
      entryQuoteId: args.quoteId,
      entryBasisId: args.basisId,
      tokenUnits: executedTokenUnits ?? sizeUsd / tokenPriceUsd,
      entryObservedAt: new Date(args.observedAtMs),
      entryQualityStatus: args.qualityStatus,
      entryQualityReason: args.qualityReason,
      entryAt: new Date(args.nowMs),
      executionMode: execution?.mode ?? "paper",
      entryExecutionId: execution?.executionId ?? null,
    });

    if (execution?.executionId != null) {
      await attachTradeExecutionSignal({ executionId: execution.executionId, signalId });
    }
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

      const execution = await this.executeClose(args, position);
      if (this.requiresLiveSuccess() && execution?.status !== "success") continue;

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
        exitExecutionId: execution?.executionId ?? null,
      });
    }
  }

  private async executeOpen(args: {
    pair: PairConfig;
    sizeUsd: number;
    basePriceUsd: number;
    tokenPriceUsd: number;
    netEdgeBps: number;
  }): Promise<TradeExecutionResult | null> {
    const executor = this.cfg.executor;
    if (!executor?.enabled) return null;
    return executor.execute({
      action: "open",
      pair: args.pair,
      side: "buy_tokenized",
      sizeUsd: args.sizeUsd,
      basePriceUsd: args.basePriceUsd,
      tokenPriceUsd: args.tokenPriceUsd,
      edgeBps: args.netEdgeBps,
      inputAmount: uiToAtomic(args.sizeUsd, args.pair.quote.decimals),
      dedupeKey: `open:${args.pair.id}:${args.sizeUsd}`,
    });
  }

  private async executeClose(
    args: {
      pair: PairConfig;
      sizeUsd: number;
      basePriceUsd: number;
      tokenPriceUsd: number;
      netEdgeBps: number;
    },
    position: {
      id: bigint;
      tokenUnits: number | null;
      executionMode: string;
      entryExecutionId: bigint | null;
    },
  ): Promise<TradeExecutionResult | null> {
    const executor = this.cfg.executor;
    if (!executor?.enabled) return null;
    if (this.requiresLiveSuccess()) {
      const liveEntry =
        position.entryExecutionId != null &&
        position.executionMode !== "paper" &&
        position.executionMode !== "jupiter-dry-run";
      if (!liveEntry || position.tokenUnits == null) return null;
    }
    return executor.execute({
      action: "close",
      pair: args.pair,
      side: "sell_tokenized",
      sizeUsd: args.sizeUsd,
      basePriceUsd: args.basePriceUsd,
      tokenPriceUsd: args.tokenPriceUsd,
      edgeBps: args.netEdgeBps,
      inputAmount: uiToAtomic(position.tokenUnits ?? 0, args.pair.tokenized.decimals),
      signalId: position.id,
      dedupeKey: `close:${position.id.toString()}`,
    });
  }

  private requiresLiveSuccess(): boolean {
    const mode = this.cfg.executor?.mode;
    return mode === "jupiter-managed" || mode === "helius-sender";
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
