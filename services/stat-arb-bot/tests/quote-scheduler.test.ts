import { expect } from "chai";
import { QuoteScheduler } from "../src/quote-scheduler";

describe("QuoteScheduler", () => {
  it("emits at most `capacity` work items in a burst", () => {
    let t = 0;
    const seen: string[] = [];
    const sched = new QuoteScheduler({
      maxRps: 5,
      bucketCapacity: 5,
      nowMs: () => t,
      onWork: (id) => seen.push(id),
    });
    sched.upsertPair({
      pairId: "p1",
      lastPriceUsd: 100,
      sides: ["buy_tokenized"],
      sizesUsd: [100, 500, 1000],
      quoteIntervalMs: 60_000,
      minPriceMoveBps: 1,
    });
    // First tick: all 3 sizes get a quote (fits under capacity 5).
    sched.onPriceTick("p1", 100);
    expect(seen.length).to.equal(3);
    // Same-price tick at t=0: no move beyond 1bps, interval not elapsed → no new work.
    seen.length = 0;
    sched.onPriceTick("p1", 100);
    expect(seen.length).to.equal(0);
  });

  it("triggers immediately on a price move beyond minPriceMoveBps", () => {
    let t = 0;
    const seen: string[] = [];
    const sched = new QuoteScheduler({
      maxRps: 10,
      bucketCapacity: 10,
      nowMs: () => t,
      onWork: (id) => seen.push(id),
    });
    sched.upsertPair({
      pairId: "p1",
      lastPriceUsd: 100,
      sides: ["buy_tokenized"],
      sizesUsd: [100],
      quoteIntervalMs: 60_000,
      minPriceMoveBps: 5,
    });
    sched.onPriceTick("p1", 100);   // baseline
    seen.length = 0;
    sched.onPriceTick("p1", 100.06); // +6 bps, > 5
    expect(seen).to.deep.equal(["p1|buy_tokenized|100"]);
  });

  it("respects the RPS budget over multiple ticks", () => {
    let t = 0;
    let workCount = 0;
    const sched = new QuoteScheduler({
      maxRps: 2,
      bucketCapacity: 2,
      nowMs: () => t,
      onWork: () => { workCount += 1; },
    });
    sched.upsertPair({
      pairId: "p1",
      lastPriceUsd: 100,
      sides: ["buy_tokenized", "sell_tokenized"],
      sizesUsd: [100, 500],
      quoteIntervalMs: 100,
      minPriceMoveBps: 1,
    });
    // First tick wants 4 work items (2 sides × 2 sizes) but only 2 tokens.
    sched.onPriceTick("p1", 100);
    expect(workCount).to.equal(2);
    // Bucket refills 2 tokens/sec → 1 token at t=500ms.
    t = 500;
    sched.onPriceTick("p1", 100.01);
    expect(workCount).to.equal(3); // exactly 1 more
  });

  it("removePair clears per-pair scheduler state", () => {
    let t = 0;
    const seen: string[] = [];
    const sched = new QuoteScheduler({
      maxRps: 10,
      bucketCapacity: 10,
      nowMs: () => t,
      onWork: (id) => seen.push(id),
    });
    sched.upsertPair({
      pairId: "p1",
      lastPriceUsd: 100,
      sides: ["buy_tokenized"],
      sizesUsd: [100],
      quoteIntervalMs: 60_000,
      minPriceMoveBps: 5,
    });
    sched.onPriceTick("p1", 100);
    seen.length = 0;
    sched.removePair("p1");
    sched.onPriceTick("p1", 200);
    expect(seen.length).to.equal(0);
    expect(sched.activePairCount).to.equal(0);
  });
});
