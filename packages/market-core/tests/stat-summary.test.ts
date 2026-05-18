import { expect } from "chai";
import { buildStatSummary, type StatObservation } from "../src/stat-summary";

function obs(
  ratio: number,
  ts: number,
  qualityStatus: StatObservation["qualityStatus"] = "LIVE_ELIGIBLE",
): StatObservation {
  return {
    side: "buy_tokenized",
    sizeUsd: 250,
    observedAtMs: ts,
    basePriceUsd: 100,
    tokenPriceUsd: 100 * ratio,
    qualityStatus,
    timeRegime: "CRYPTO_NORMAL",
  };
}

describe("stat summary", () => {
  it("returns an empty summary when no live observations exist", () => {
    const result = buildStatSummary({
      side: "buy_tokenized",
      sizeUsd: 250,
      observations: [obs(0.99, 0, "STALE_PYTH")],
      nowMs: 10_000,
      options: { windowMs: 60_000 },
    });
    expect(result.liveSampleCount).to.equal(0);
    expect(result.fairRatio).to.equal(null);
    expect(result.currentDeviationBps).to.equal(null);
    expect(result.deviationQuantilesBps.p50).to.equal(null);
  });

  it("computes deviation around the rolling fair ratio, not 1.0000", () => {
    const observations: StatObservation[] = [
      obs(0.99, 0),
      obs(0.989, 1_000),
      obs(0.991, 2_000),
      obs(0.985, 3_000),
      obs(0.995, 4_000),
    ];
    const result = buildStatSummary({
      side: "buy_tokenized",
      sizeUsd: 250,
      observations,
      nowMs: 5_000,
      options: { windowMs: 10_000 },
    });
    expect(result.liveSampleCount).to.equal(5);
    expect(result.fairRatio).to.be.closeTo(0.99, 1e-9);
    expect(result.currentRatio).to.equal(0.995);
    expect(result.currentDeviationBps).to.be.greaterThan(0);
    expect(result.medianDeviationBps).to.equal(0);
  });

  it("counts opportunities and cheap/rich tails above threshold", () => {
    const observations: StatObservation[] = [
      obs(1.0, 0),
      obs(1.01, 1_000),
      obs(1.012, 2_000),
      obs(1.0, 3_000),
      obs(0.985, 4_000),
      obs(0.984, 5_000),
      obs(1.0, 6_000),
    ];
    const result = buildStatSummary({
      side: "buy_tokenized",
      sizeUsd: 250,
      observations,
      nowMs: 6_000,
      options: { windowMs: 10_000, opportunityThresholdBps: 50 },
    });
    expect(result.opportunityCount).to.equal(2);
    expect(result.cheapTailCount + result.richTailCount).to.be.greaterThan(0);
  });

  it("groups regime breakdown by time regime", () => {
    const observations: StatObservation[] = [
      { ...obs(1.0, 0), timeRegime: "CRYPTO_NORMAL" },
      { ...obs(1.005, 1_000), timeRegime: "CRYPTO_NORMAL" },
      { ...obs(0.99, 2_000), timeRegime: "CRYPTO_HIGH_VOL" },
    ];
    const result = buildStatSummary({
      side: "buy_tokenized",
      sizeUsd: 250,
      observations,
      nowMs: 3_000,
      options: { windowMs: 10_000 },
    });
    expect(result.regimeBreakdown.map((r) => r.regime)).to.include.members([
      "CRYPTO_NORMAL",
      "CRYPTO_HIGH_VOL",
    ]);
  });

  it("withholds half-life when sample count is below threshold", () => {
    const result = buildStatSummary({
      side: "buy_tokenized",
      sizeUsd: 250,
      observations: [obs(1.0, 0), obs(0.99, 1_000), obs(1.0, 2_000)],
      nowMs: 3_000,
      options: { windowMs: 10_000, minHalfLifeSamples: 10 },
    });
    expect(result.halfLifeSeconds).to.equal(null);
  });
});
