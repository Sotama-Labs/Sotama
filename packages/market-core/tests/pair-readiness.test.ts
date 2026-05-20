import { expect } from "chai";
import {
  buildPairReadinessMatrix,
  type PairReadinessObservation,
  type PairReadinessQuoteStats,
} from "../src/pair-readiness";
import type { PairConfig } from "../src/pair-config";

const pair: PairConfig = {
  id: "spy-sply",
  enabled: true,
  label: "SPY vs tokenized SPY",
  base: { pythSymbol: "Equity.US.SPY/USD", pythLazerId: 1, exponent: -8, assetClass: "Equity" },
  tokenized: { mint: "TokenizedSpy111111111111111111111111111111111", symbol: "SPYx", decimals: 6 },
  quote: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
  sizesUsd: [250, 1000],
  directions: ["buy_tokenized", "sell_tokenized"],
  quoteIntervalMs: 1000,
  minPriceMoveBps: 1,
  slippageBps: 30,
  minNetEdgeBps: 20,
};

function obs(side: "buy_tokenized" | "sell_tokenized", sizeUsd: number): PairReadinessObservation {
  return {
    side,
    sizeUsd,
    observedAtMs: Date.now(),
    pythFeedUpdateTimestampUs: 1,
    quoteRequestMs: 100,
    basisAgeMs: 200,
    timeRegime: "US_EQUITY_REGULAR",
    qualityStatus: "LIVE_ELIGIBLE",
  };
}

function stats(side: "buy_tokenized" | "sell_tokenized", sizeUsd: number): PairReadinessQuoteStats {
  return {
    side,
    sizeUsd,
    totalCount: 4,
    okCount: 4,
    routerDistribution: [{ router: "jupiterz", count: 4, pct: 1 }],
  };
}

describe("PairReadinessMatrix", () => {
  it("marks all side/size rows READY when routes, samples, sessions, and latency exist", () => {
    const matrix = buildPairReadinessMatrix({
      pair,
      observations: [
        obs("buy_tokenized", 250),
        obs("buy_tokenized", 250),
        obs("sell_tokenized", 250),
        obs("sell_tokenized", 250),
        obs("buy_tokenized", 1000),
        obs("buy_tokenized", 1000),
        obs("sell_tokenized", 1000),
        obs("sell_tokenized", 1000),
      ],
      quoteStats: [
        stats("buy_tokenized", 250),
        stats("sell_tokenized", 250),
        stats("buy_tokenized", 1000),
        stats("sell_tokenized", 1000),
      ],
      options: { minSampleCount: 2 },
    });
    expect(matrix.status).to.equal("READY");
    expect(matrix.rows.every((row) => row.status === "READY")).to.equal(true);
  });

  it("marks rows RESEARCH_ONLY when routes exist but sample count is low", () => {
    const matrix = buildPairReadinessMatrix({
      pair,
      observations: [obs("buy_tokenized", 250), obs("sell_tokenized", 250)],
      quoteStats: [stats("buy_tokenized", 250), stats("sell_tokenized", 250)],
      options: { minSampleCount: 2 },
    });
    const buy250 = matrix.rows.find((row) => row.side === "buy_tokenized" && row.sizeUsd === 250)!;
    expect(buy250.status).to.equal("RESEARCH_ONLY");
    expect(buy250.reasonCodes).to.include("SAMPLE_COUNT_LOW");
  });

  it("marks missing configured routes as NOT_READY", () => {
    const matrix = buildPairReadinessMatrix({
      pair,
      observations: [obs("buy_tokenized", 250), obs("sell_tokenized", 250)],
      quoteStats: [],
      options: { minSampleCount: 1 },
    });
    const sell250 = matrix.rows.find((row) => row.side === "sell_tokenized" && row.sizeUsd === 250)!;
    expect(sell250.status).to.equal("NOT_READY");
    expect(sell250.reasonCodes).to.include("SELL_ROUTE_MISSING");
  });

  it("keeps stale diagnostic route probes out of NOT_READY when feeds and routes exist", () => {
    const staleObs = (
      side: "buy_tokenized" | "sell_tokenized",
      sizeUsd: number,
    ): PairReadinessObservation => ({
      ...obs(side, sizeUsd),
      qualityStatus: "STALE_PYTH",
      timeRegime: "US_EQUITY_OVERNIGHT",
    });
    const matrix = buildPairReadinessMatrix({
      pair,
      observations: [
        staleObs("buy_tokenized", 250),
        staleObs("sell_tokenized", 250),
        staleObs("buy_tokenized", 1000),
        staleObs("sell_tokenized", 1000),
      ],
      quoteStats: [
        stats("buy_tokenized", 250),
        stats("sell_tokenized", 250),
        stats("buy_tokenized", 1000),
        stats("sell_tokenized", 1000),
      ],
      options: { minSampleCount: 2 },
    });
    const buy250 = matrix.rows.find((row) => row.side === "buy_tokenized" && row.sizeUsd === 250)!;

    expect(matrix.status).to.equal("RESEARCH_ONLY");
    expect(buy250.status).to.equal("RESEARCH_ONLY");
    expect(buy250.reasonCodes).to.not.include("NO_FEED_UPDATES");
    expect(buy250.reasonCodes).to.not.include("BUY_ROUTE_MISSING");
  });
});
