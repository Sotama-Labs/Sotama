import { expect } from "chai";
import { PairConfigSchema, type PairConfig } from "../src/pair-config";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_MINT = "XaUt00000000000000000000000000000000000000z";

const valid: PairConfig = {
  id: "xau-xaut0",
  enabled: true,
  label: "XAU vs XAUT0",
  base: { pythSymbol: "Metal.XAU/USD", pythLazerId: 7, exponent: -8, assetClass: "Metal" },
  tokenized: { mint: TOKEN_MINT, symbol: "XAUT0", decimals: 6 },
  quote: { mint: USDC_MINT, symbol: "USDC", decimals: 6 },
  sizesUsd: [250, 1000],
  directions: ["buy_tokenized", "sell_tokenized"],
  quoteIntervalMs: 2000,
  minPriceMoveBps: 2,
  slippageBps: 50,
  minNetEdgeBps: 20,
};

describe("PairConfigSchema", () => {
  it("accepts a valid config", () => {
    expect(() => PairConfigSchema.parse(valid)).to.not.throw();
  });
  it("accepts per-pair quote quality overrides", () => {
    expect(() => PairConfigSchema.parse({
      ...valid,
      qualityGate: {
        maxQuoteLatencyMs: 750,
        allowedRouters: ["jupiterz"],
        allowedMarketSessions: ["METAL_ACTIVE"],
      },
    })).to.not.throw();
  });
  it("rejects empty sizesUsd", () => {
    expect(() => PairConfigSchema.parse({ ...valid, sizesUsd: [] })).to.throw();
  });
  it("rejects inactive quote sizes for the current tuning phase", () => {
    expect(() => PairConfigSchema.parse({ ...valid, sizesUsd: [100, 500] })).to.throw();
  });
  it("rejects negative thresholds", () => {
    expect(() => PairConfigSchema.parse({ ...valid, minNetEdgeBps: -1 })).to.throw();
  });
  it("rejects empty directions", () => {
    expect(() => PairConfigSchema.parse({ ...valid, directions: [] })).to.throw();
  });
  it("rejects unknown asset class", () => {
    expect(() => PairConfigSchema.parse({
      ...valid,
      base: { ...valid.base, assetClass: "Bond" as any },
    })).to.throw();
  });
  it("rejects quote symbol that isn't USDC (V1 constraint)", () => {
    expect(() => PairConfigSchema.parse({
      ...valid,
      quote: { ...valid.quote, symbol: "USDT" as any },
    })).to.throw();
  });
});
