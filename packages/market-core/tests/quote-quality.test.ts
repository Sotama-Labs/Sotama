import { expect } from "chai";
import {
  DEFAULT_QUOTE_QUALITY_THRESHOLDS,
  buildQuoteQualityThresholds,
  classifyQuoteQuality,
  observationQualityFromStatus,
  type QuoteQualityInput,
} from "../src/quote-quality";

const liveInput: QuoteQualityInput = {
  pythFreshnessLagMs: 100,
  quoteRequestMs: 250,
  basisAgeMs: 350,
  priceImpactPct: 0.05,
  pythConfidenceBps: 2,
  router: "jupiterz",
  timeRegime: "US_EQUITY_REGULAR",
  decimalsVerified: true,
};

describe("quote quality gate", () => {
  it("classifies clean quotes as LIVE_ELIGIBLE", () => {
    const q = classifyQuoteQuality(liveInput, DEFAULT_QUOTE_QUALITY_THRESHOLDS);
    expect(q.qualityStatus).to.equal("LIVE_ELIGIBLE");
    expect(observationQualityFromStatus(q.qualityStatus)).to.equal("live");
  });

  it("rejects stale Pyth data before evaluating downstream quote fields", () => {
    const q = classifyQuoteQuality(
      { ...liveInput, pythFreshnessLagMs: 5001, router: null },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    );
    expect(q.qualityStatus).to.equal("STALE_PYTH");
    expect(observationQualityFromStatus(q.qualityStatus)).to.equal("stale");
  });

  it("rejects stale basis age and slow quote latency", () => {
    expect(classifyQuoteQuality(
      { ...liveInput, basisAgeMs: 5001 },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    ).qualityStatus).to.equal("STALE_BASIS");
    expect(classifyQuoteQuality(
      { ...liveInput, quoteRequestMs: 1501 },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    ).qualityStatus).to.equal("QUOTE_LATENCY_TOO_HIGH");
  });

  it("rejects invalid market regimes", () => {
    const q = classifyQuoteQuality(
      { ...liveInput, timeRegime: "US_EQUITY_POSTMARKET" },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    );
    expect(q.qualityStatus).to.equal("MARKET_SESSION_INVALID");
  });

  it("rejects price impact and Pyth confidence outside thresholds", () => {
    expect(classifyQuoteQuality(
      { ...liveInput, priceImpactPct: 0.51 },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    ).qualityStatus).to.equal("PRICE_IMPACT_TOO_HIGH");
    expect(classifyQuoteQuality(
      { ...liveInput, pythConfidenceBps: 26 },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    ).qualityStatus).to.equal("PYTH_CONFIDENCE_TOO_WIDE");
  });

  it("enforces router allowlists", () => {
    const thresholds = buildQuoteQualityThresholds({
      allowedRouters: ["jupiterz"],
    });
    expect(classifyQuoteQuality(liveInput, thresholds).qualityStatus).to.equal("LIVE_ELIGIBLE");
    expect(classifyQuoteQuality(
      { ...liveInput, router: "other" },
      thresholds,
    ).qualityStatus).to.equal("UNKNOWN_ROUTER");
  });

  it("tracks route stability, exit quote availability, and decimals verification", () => {
    expect(classifyQuoteQuality(
      { ...liveInput, routeStable: false },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    ).qualityStatus).to.equal("ROUTE_UNSTABLE");
    expect(classifyQuoteQuality(
      { ...liveInput, hasExitQuote: false },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    ).qualityStatus).to.equal("MISSING_EXIT_QUOTE");
    expect(classifyQuoteQuality(
      { ...liveInput, decimalsVerified: false },
      DEFAULT_QUOTE_QUALITY_THRESHOLDS,
    ).qualityStatus).to.equal("DECIMALS_UNVERIFIED");
  });
});
