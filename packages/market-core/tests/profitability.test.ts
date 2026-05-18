import { expect } from "chai";
import { summarize, type ClosedSignal } from "../src/profitability";

const ms = (s: number) => s * 1000;

const trades: ClosedSignal[] = [
  { entryAt: 0,       exitAt: ms(60),   pnlUsd:  10, edgeBps: 30 },
  { entryAt: ms(120), exitAt: ms(180),  pnlUsd: -5,  edgeBps: 22 },
  { entryAt: ms(240), exitAt: ms(360),  pnlUsd:  20, edgeBps: 45 },
];

describe("profitability", () => {
  it("computes cumulative PnL and count", () => {
    const s = summarize(trades, ms(1000));
    expect(s.cumulativePnlUsd).to.equal(25);
    expect(s.signalCount).to.equal(3);
  });
  it("computes win rate", () => {
    expect(summarize(trades, ms(1000)).winRate).to.be.closeTo(2/3, 1e-9);
  });
  it("computes max drawdown from the equity curve", () => {
    // equity curve: 10, 5, 25; running max 10, 10, 25; drawdown max = 5
    expect(summarize(trades, ms(1000)).maxDrawdownUsd).to.equal(5);
  });
  it("computes average hold time in seconds", () => {
    // hold durations: 60, 60, 120 -> avg 80
    expect(summarize(trades, ms(1000)).avgHoldSeconds).to.be.closeTo(80, 1e-9);
  });
  it("returns zeros on empty input", () => {
    const s = summarize([], 0);
    expect(s.cumulativePnlUsd).to.equal(0);
    expect(s.winRate).to.equal(0);
    expect(s.maxDrawdownUsd).to.equal(0);
    expect(s.signalCount).to.equal(0);
  });
});
