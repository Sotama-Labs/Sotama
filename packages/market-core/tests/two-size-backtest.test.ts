import { expect } from "chai";
import {
  runTwoSizeBacktestV2,
  type TwoSizeBacktestObservation,
} from "../src/two-size-backtest";

function row(args: Partial<TwoSizeBacktestObservation> & {
  side: "buy_tokenized" | "sell_tokenized";
  sizeUsd: number;
  observedAtMs: number;
}): TwoSizeBacktestObservation {
  return {
    basePriceUsd: 100,
    tokenPriceUsd: args.side === "buy_tokenized" ? 95 : 100,
    netBps: args.side === "buy_tokenized" ? 30 : 0,
    qualityStatus: "LIVE_ELIGIBLE",
    ...args,
  };
}

describe("TwoSizeBacktestV2", () => {
  it("avoids look-ahead by requiring a known opposite-side route before entry", () => {
    const result = runTwoSizeBacktestV2({
      observations: [
        row({ side: "buy_tokenized", sizeUsd: 250, observedAtMs: 1 }),
        row({ side: "sell_tokenized", sizeUsd: 250, observedAtMs: 2 }),
        row({ side: "buy_tokenized", sizeUsd: 250, observedAtMs: 3 }),
        row({ side: "sell_tokenized", sizeUsd: 250, observedAtMs: 4 }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 10,
        minLiveSamples: 1,
      },
    });
    expect(result.sizeResults[0]!.closedTrades).to.equal(1);
    expect(result.skippedSignalReasons).to.deep.include({
      reason: "MISSING_EXIT_QUOTE",
      count: 1,
    });
  });

  it("excludes stale quotes from entry and exit replay", () => {
    const result = runTwoSizeBacktestV2({
      observations: [
        row({ side: "sell_tokenized", sizeUsd: 250, observedAtMs: 1 }),
        row({ side: "buy_tokenized", sizeUsd: 250, observedAtMs: 2 }),
        row({
          side: "sell_tokenized",
          sizeUsd: 250,
          observedAtMs: 3,
          tokenPriceUsd: 101,
          qualityStatus: "STALE_PYTH",
        }),
        row({ side: "sell_tokenized", sizeUsd: 250, observedAtMs: 4, tokenPriceUsd: 101 }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 10,
        minLiveSamples: 1,
      },
    });
    expect(result.sizeResults[0]!.closedTrades).to.equal(1);
    expect(result.skippedSignalReasons).to.deep.include({ reason: "NON_LIVE", count: 1 });
  });

  it("computes marginal next-$750 edge and recommends the larger size when marginal edge clears", () => {
    const result = runTwoSizeBacktestV2({
      observations: [
        row({ side: "sell_tokenized", sizeUsd: 250, observedAtMs: 1 }),
        row({ side: "sell_tokenized", sizeUsd: 1000, observedAtMs: 1 }),
        row({ side: "buy_tokenized", sizeUsd: 250, observedAtMs: 2, tokenPriceUsd: 99, netBps: 30 }),
        row({ side: "buy_tokenized", sizeUsd: 1000, observedAtMs: 3, tokenPriceUsd: 98, netBps: 40 }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 0,
        minLiveSamples: 1,
      },
    });
    expect(result.edgeNext750Bps).to.be.greaterThan(20);
    expect(result.recommendedAction).to.equal("TRADE_1000");
  });

  it("returns RESEARCH_ONLY when readiness has not cleared", () => {
    const result = runTwoSizeBacktestV2({
      observations: [
        row({ side: "sell_tokenized", sizeUsd: 250, observedAtMs: 1 }),
        row({ side: "buy_tokenized", sizeUsd: 250, observedAtMs: 2 }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 10,
        minLiveSamples: 1,
        researchOnly: true,
      },
    });
    expect(result.recommendedAction).to.equal("RESEARCH_ONLY");
  });
});
