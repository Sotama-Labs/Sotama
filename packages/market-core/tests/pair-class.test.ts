import { expect } from "chai";
import {
  inferPairClass,
  pairClassForAssetClass,
  referenceStatusFor,
} from "../src/pair-class";
import type { PairConfig } from "../src/pair-config";

const cryptoPair: PairConfig = {
  id: "wbtc-btc",
  enabled: true,
  label: "WBTC/BTC",
  base: { pythSymbol: "Crypto.BTC/USD", pythLazerId: 1, exponent: -8, assetClass: "Crypto" },
  tokenized: { mint: "x".repeat(43), symbol: "WBTC", decimals: 8 },
  quote: { mint: "y".repeat(44), symbol: "USDC", decimals: 6 },
  sizesUsd: [250, 1000],
  directions: ["buy_tokenized", "sell_tokenized"],
  quoteIntervalMs: 1000,
  minPriceMoveBps: 1,
  slippageBps: 30,
  minNetEdgeBps: 20,
};

describe("pair class", () => {
  it("infers a class from AssetClass", () => {
    expect(inferPairClass(cryptoPair)).to.equal("BRIDGED_CRYPTO");
    expect(pairClassForAssetClass("Equity")).to.equal("TOKENIZED_EQUITY");
    expect(pairClassForAssetClass("Metal")).to.equal("TOKENIZED_METAL");
    expect(pairClassForAssetClass("Commodity")).to.equal("TOKENIZED_COMMODITY");
    expect(pairClassForAssetClass("FX")).to.equal("TOKENIZED_FX");
  });
});

describe("reference status", () => {
  it("returns LIVE_REFERENCE for bridged crypto during normal regime", () => {
    expect(
      referenceStatusFor({ pairClass: "BRIDGED_CRYPTO", timeRegime: "CRYPTO_NORMAL" }),
    ).to.equal("LIVE_REFERENCE");
    expect(
      referenceStatusFor({ pairClass: "BRIDGED_CRYPTO", timeRegime: "CRYPTO_HIGH_VOL" }),
    ).to.equal("LIVE_REFERENCE");
  });

  it("returns REFERENCE_CLOSED for tokenized equity outside the regular session", () => {
    expect(
      referenceStatusFor({ pairClass: "TOKENIZED_EQUITY", timeRegime: "US_EQUITY_REGULAR" }),
    ).to.equal("LIVE_REFERENCE");
    expect(
      referenceStatusFor({ pairClass: "TOKENIZED_EQUITY", timeRegime: "US_EQUITY_PREMARKET" }),
    ).to.equal("REFERENCE_CLOSED");
    expect(
      referenceStatusFor({ pairClass: "TOKENIZED_EQUITY", timeRegime: "US_EQUITY_WEEKEND" }),
    ).to.equal("REFERENCE_CLOSED");
  });

  it("returns REFERENCE_CLOSED for metal maintenance and weekend", () => {
    expect(
      referenceStatusFor({ pairClass: "TOKENIZED_METAL", timeRegime: "METAL_ACTIVE" }),
    ).to.equal("LIVE_REFERENCE");
    expect(
      referenceStatusFor({ pairClass: "TOKENIZED_METAL", timeRegime: "METAL_MAINTENANCE" }),
    ).to.equal("REFERENCE_CLOSED");
  });

  it("returns REFERENCE_STALE when the freshness lag exceeds the configured cap", () => {
    expect(
      referenceStatusFor({
        pairClass: "BRIDGED_CRYPTO",
        timeRegime: "CRYPTO_NORMAL",
        pythFreshnessLagMs: 10_000,
        maxPythFreshnessLagMs: 2_500,
      }),
    ).to.equal("REFERENCE_STALE");
  });

  it("returns REFERENCE_UNCERTAIN when the regime is missing", () => {
    expect(
      referenceStatusFor({ pairClass: "BRIDGED_CRYPTO", timeRegime: null }),
    ).to.equal("REFERENCE_UNCERTAIN");
  });
});
