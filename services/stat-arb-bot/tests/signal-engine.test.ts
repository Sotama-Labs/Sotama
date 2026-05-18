import { expect } from "chai";
import { computeSpotExitPnlUsd } from "../src/signal-engine";

describe("SignalEngine paper PnL", () => {
  it("treats convergence from a discount buy to base-price sell as profit", () => {
    const tokenUnits = 1000 / 95;
    const pnl = computeSpotExitPnlUsd({
      sizeUsd: 1000,
      tokenUnits,
      exitTokenPriceUsd: 100,
      transactionCostBps: 10,
    });
    expect(pnl).to.be.greaterThan(50);
  });

  it("charges both entry and exit paper costs", () => {
    const pnl = computeSpotExitPnlUsd({
      sizeUsd: 1000,
      tokenUnits: 10,
      exitTokenPriceUsd: 100,
      transactionCostBps: 10,
    });
    expect(pnl).to.equal(-2);
  });
});
