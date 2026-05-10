import { expect } from "chai";
import {
  resolveOracleForPair,
  searchFeedsByClass,
  fetchPythLatest,
} from "../src/lib/oracles";
import { fetchJupiterPriceUSD } from "../src/lib/jupiter";

const WIF = {
  symbol: "$WIF", displaySymbol: "$WIF", name: "dogwifhat",
  assetClass: "Crypto" as const,
  mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", decimals: 6,
};
const SOL = {
  symbol: "SOL", displaySymbol: "SOL", name: "Solana",
  assetClass: "Crypto" as const,
  mint: "So11111111111111111111111111111111111111112", decimals: 9,
};

describe("end-to-end: Jupiter base + non-USD quote", () => {
  it("resolves WIF as Jupiter source", async () => {
    const oracle = await resolveOracleForPair(WIF, { kind: "asset", asset: SOL });
    expect(oracle.kind).to.equal("jupiter");
  });

  it("resolves SOL/USD as Pyth source for the quote leg", async () => {
    const oracle = await resolveOracleForPair(SOL, { kind: "usd" });
    expect(oracle.kind).to.equal("pyth");
  });

  it("typed-search SOL returns AssetRef WITH mint (regression: Hermes-only had no mint, broke Jupiter-base quote)", async () => {
    const results = await searchFeedsByClass("Crypto", "SOL");
    expect(results.length).to.be.greaterThan(0);
    const sol = results.find((a) => a.symbol === "SOL");
    expect(sol, "SOL in typed-search results").to.exist;
    expect(sol?.mint, "SOL.mint after Hermes search").to.equal(SOL.mint);
  });

  it("computes WIF/SOL ratio correctly from live USD prices", async () => {
    const baseOracle = await resolveOracleForPair(WIF, { kind: "asset", asset: SOL });
    expect(baseOracle.kind).to.equal("jupiter");
    if (baseOracle.kind !== "jupiter") return;

    const baseUsd = await fetchJupiterPriceUSD(baseOracle.mint);
    expect(baseUsd, "WIF/USD").to.exist;

    const quoteOracle = await resolveOracleForPair(SOL, { kind: "usd" });
    expect(quoteOracle.kind).to.equal("pyth");
    if (quoteOracle.kind !== "pyth") return;

    const quoteUsd = await fetchPythLatest(quoteOracle.feedId);
    expect(quoteUsd, "SOL/USD pyth").to.exist;

    if (baseUsd && quoteUsd) {
      const ratio = baseUsd.price / quoteUsd.price;
      console.log(`    [live] WIF/USD=${baseUsd.price}, SOL/USD=${quoteUsd.price}, WIF/SOL=${ratio}`);
      // WIF/SOL should be a small SOL fraction, NOT the same as WIF/USD
      expect(ratio).not.to.equal(baseUsd.price);
      expect(ratio).to.be.lessThan(baseUsd.price);
      // sanity bounds for a memecoin priced in SOL
      expect(ratio).to.be.greaterThan(0);
      expect(ratio).to.be.lessThan(1);
    }
  });
});
