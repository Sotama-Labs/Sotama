import { expect } from "chai";
import {
  describeDisplayBasis,
  displayBasisBps,
  displayRatio,
  interpretDisplayBasisBps,
  pairDisplayLabel,
  pairRatioLabel,
  underlyingSymbolFromPythSymbol,
} from "../src/display-orientation";
import type { PairConfig } from "../src/pair-config";

const samplePair: PairConfig = {
  id: "wbtc-btc",
  enabled: true,
  label: "WBTC vs BTC",
  base: {
    pythSymbol: "Crypto.BTC/USD",
    pythLazerId: 1,
    exponent: -8,
    assetClass: "Crypto",
  },
  tokenized: {
    mint: "WBTCmint111111111111111111111111111111111111",
    symbol: "WBTC",
    decimals: 8,
  },
  quote: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    decimals: 6,
  },
  sizesUsd: [250, 1000],
  directions: ["buy_tokenized", "sell_tokenized"],
  quoteIntervalMs: 1000,
  minPriceMoveBps: 1,
  slippageBps: 30,
  minNetEdgeBps: 20,
};

describe("display orientation", () => {
  describe("underlyingSymbolFromPythSymbol", () => {
    it("strips Pyth prefix and quote symbol", () => {
      expect(underlyingSymbolFromPythSymbol("Crypto.BTC/USD")).to.equal("BTC");
      expect(underlyingSymbolFromPythSymbol("Equity.US.AAPL/USD")).to.equal("AAPL");
      expect(underlyingSymbolFromPythSymbol("Metal.XAU/USD")).to.equal("XAU");
    });
    it("returns empty for blank input", () => {
      expect(underlyingSymbolFromPythSymbol("   ")).to.equal("");
    });
  });

  describe("pairDisplayLabel", () => {
    it("yields tokenized/underlying canonical form", () => {
      expect(pairDisplayLabel(samplePair)).to.equal("WBTC/BTC");
      expect(pairRatioLabel(samplePair)).to.equal("WBTC/BTC ratio");
    });
    it("falls back to operator label when pyth symbol is malformed", () => {
      const malformed: PairConfig = {
        ...samplePair,
        base: { ...samplePair.base, pythSymbol: "" },
      };
      expect(pairDisplayLabel(malformed)).to.equal("WBTC vs BTC");
    });
  });

  describe("displayRatio", () => {
    it("computes token / base", () => {
      expect(displayRatio(99, 100)).to.equal(0.99);
    });
    it("returns null when either price missing or non-positive", () => {
      expect(displayRatio(null, 100)).to.equal(null);
      expect(displayRatio(99, 0)).to.equal(null);
      expect(displayRatio(undefined, 1)).to.equal(null);
    });
  });

  describe("displayBasisBps + interpretation", () => {
    it("returns negative bps for onchain cheap, positive for onchain rich", () => {
      const ratio = 0.99;
      const bps = displayBasisBps(ratio)!;
      expect(bps).to.be.closeTo(-100, 1e-6);
      expect(interpretDisplayBasisBps(bps)).to.equal("ONCHAIN_CHEAP");
      expect(interpretDisplayBasisBps(displayBasisBps(1.005)!)).to.equal("ONCHAIN_RICH");
    });
    it("flags small deviations as AT_PARITY", () => {
      expect(interpretDisplayBasisBps(3, 5)).to.equal("AT_PARITY");
    });
  });

  describe("describeDisplayBasis", () => {
    it("packs ratio, bps, and interpretation in one call", () => {
      const result = describeDisplayBasis({ tokenPriceUsd: 98, basePriceUsd: 100 });
      expect(result.ratio).to.equal(0.98);
      expect(result.basisBps).to.be.closeTo(-200, 1e-6);
      expect(result.interpretation).to.equal("ONCHAIN_CHEAP");
    });
  });
});
