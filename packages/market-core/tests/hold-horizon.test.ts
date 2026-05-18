import { expect } from "chai";
import {
  runHoldHorizonReplay,
  type HoldHorizonObservation,
} from "../src/hold-horizon";

function row(args: Partial<HoldHorizonObservation> & {
  side: "buy_tokenized" | "sell_tokenized";
  observedAtMs: number;
}): HoldHorizonObservation {
  return {
    side: args.side,
    sizeUsd: args.sizeUsd ?? 250,
    observedAtMs: args.observedAtMs,
    tokenPriceUsd: args.side === "buy_tokenized" ? 95 : 95,
    netBps: args.side === "buy_tokenized" ? 30 : 0,
    qualityStatus: "LIVE_ELIGIBLE",
    ...args,
  };
}

describe("hold horizon replay", () => {
  it("waits until profitability is achieved inside the horizon", () => {
    const [result] = runHoldHorizonReplay({
      observations: [
        row({ side: "sell_tokenized", observedAtMs: 0, tokenPriceUsd: 95 }),
        row({ side: "buy_tokenized", observedAtMs: 1_000, tokenPriceUsd: 95 }),
        row({ side: "sell_tokenized", observedAtMs: 10_000, tokenPriceUsd: 95.1 }),
        row({ side: "sell_tokenized", observedAtMs: 90_000, tokenPriceUsd: 101 }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 10,
        horizonsMs: [120_000],
      },
    });
    expect(result!.closedTrades).to.equal(1);
    expect(result!.timedOutTrades).to.equal(0);
    expect(result!.avgHoldSeconds).to.equal(89);
    expect(result!.pnlUsd).to.be.greaterThan(0);
  });

  it("times out with the first available sell quote after the horizon", () => {
    const [result] = runHoldHorizonReplay({
      observations: [
        row({ side: "sell_tokenized", observedAtMs: 0, tokenPriceUsd: 95 }),
        row({ side: "buy_tokenized", observedAtMs: 1_000, tokenPriceUsd: 95 }),
        row({ side: "sell_tokenized", observedAtMs: 10_000, tokenPriceUsd: 94 }),
        row({ side: "sell_tokenized", observedAtMs: 70_000, tokenPriceUsd: 94 }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 10,
        horizonsMs: [60_000],
      },
    });
    expect(result!.closedTrades).to.equal(1);
    expect(result!.timedOutTrades).to.equal(1);
    expect(result!.pnlUsd).to.be.lessThan(0);
  });

  it("excludes non-live observations from entries and exits", () => {
    const [result] = runHoldHorizonReplay({
      observations: [
        row({ side: "sell_tokenized", observedAtMs: 0, tokenPriceUsd: 95 }),
        row({ side: "buy_tokenized", observedAtMs: 1_000, tokenPriceUsd: 95 }),
        row({
          side: "sell_tokenized",
          observedAtMs: 20_000,
          tokenPriceUsd: 101,
          qualityStatus: "STALE_PYTH",
        }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 10,
        horizonsMs: [60_000],
      },
    });
    expect(result!.closedTrades).to.equal(0);
    expect(result!.openPositions).to.equal(1);
  });

  it("does not use future sell routes to justify an earlier entry", () => {
    const [result] = runHoldHorizonReplay({
      observations: [
        row({ side: "buy_tokenized", observedAtMs: 1_000, tokenPriceUsd: 95 }),
        row({ side: "sell_tokenized", observedAtMs: 20_000, tokenPriceUsd: 101 }),
      ],
      options: {
        minNetEdgeBps: 20,
        transactionCostBps: 10,
        horizonsMs: [60_000],
      },
    });
    expect(result!.closedTrades).to.equal(0);
    expect(result!.openPositions).to.equal(0);
  });
});
