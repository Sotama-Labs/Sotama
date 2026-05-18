import { expect } from "chai";
import { assertQuoteRpsBudget, estimateQuoteRps, TokenBucket } from "../src/rps-budget";

describe("rps-budget", () => {
  it("starts full and allows up to capacity bursts", () => {
    const b = new TokenBucket({ capacity: 5, refillPerSec: 5, nowMs: () => 0 });
    for (let i = 0; i < 5; i++) expect(b.tryTake()).to.equal(true);
    expect(b.tryTake()).to.equal(false);
  });
  it("refills over time at the configured rate", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 5, refillPerSec: 5, nowMs: () => t });
    for (let i = 0; i < 5; i++) b.tryTake();
    t = 1000;
    for (let i = 0; i < 5; i++) expect(b.tryTake()).to.equal(true);
    expect(b.tryTake()).to.equal(false);
  });
  it("partial refill", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 10, refillPerSec: 10, nowMs: () => t });
    for (let i = 0; i < 10; i++) b.tryTake();
    t = 500;
    for (let i = 0; i < 5; i++) expect(b.tryTake()).to.equal(true);
    expect(b.tryTake()).to.equal(false);
  });
  it("caps refill at capacity", () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 5, refillPerSec: 5, nowMs: () => t });
    t = 1_000_000;
    expect(b.available).to.equal(5);
  });
  it("rejects bad config", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSec: 1, nowMs: () => 0 })).to.throw();
    expect(() => new TokenBucket({ capacity: 1, refillPerSec: 0, nowMs: () => 0 })).to.throw();
  });
  it("estimates enabled quote workload", () => {
    expect(estimateQuoteRps([
      { directions: ["buy", "sell"], sizesUsd: [250, 1000], quoteIntervalMs: 2000 },
      { directions: ["buy"], sizesUsd: [250], quoteIntervalMs: 1000 },
    ])).to.equal(3);
  });
  it("rejects workloads above the configured headroom", () => {
    expect(() =>
      assertQuoteRpsBudget({
        pairs: [
          { directions: ["buy", "sell"], sizesUsd: [250, 1000], quoteIntervalMs: 1000 },
        ],
        maxRps: 4,
      }),
    ).to.throw(/above 85%/);
  });
});
