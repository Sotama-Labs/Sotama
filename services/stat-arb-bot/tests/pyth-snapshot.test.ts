import { expect } from "chai";
import { PythSnapshotClient } from "../src/pyth-snapshot";
import type { PairConfig } from "@sotama/market-core";

const pair: PairConfig = {
  id: "aapl-aaplx",
  enabled: true,
  label: "AAPL vs tokenized AAPL",
  base: {
    pythSymbol: "Equity.US.AAPL/USD",
    pythLazerId: 922,
    exponent: -5,
    assetClass: "Equity",
  },
  tokenized: {
    mint: "TokenizedAapl11111111111111111111111111111111",
    symbol: "AAPLx",
    decimals: 6,
  },
  quote: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    decimals: 6,
  },
  sizesUsd: [250, 1000],
  directions: ["buy_tokenized", "sell_tokenized"],
  quoteIntervalMs: 2000,
  minPriceMoveBps: 1,
  slippageBps: 30,
  minNetEdgeBps: 20,
};

describe("PythSnapshotClient", () => {
  it("resolves Lazer symbols to Hermes latest price ticks", async () => {
    const fetches: string[] = [];
    const fetchImpl = async (url: RequestInfo | URL) => {
      const u = String(url);
      fetches.push(u);
      if (u.includes("/symbols")) {
        return jsonResponse([
          {
            symbol: "Equity.US.AAPL/USD",
            pyth_lazer_id: 922,
            hermes_id: "0xabc123",
            state: "stable",
          },
        ]);
      }
      return jsonResponse({
        parsed: [
          {
            id: "abc123",
            price: {
              price: "19345000",
              conf: "1200",
              expo: -5,
              publish_time: 1_800_000_000,
            },
          },
        ],
      });
    };
    const client = new PythSnapshotClient({
      hermesBaseUrl: "https://hermes.example",
      lazerSymbolsUrl: "https://lazer.example/symbols",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const tick = await client.latestForPair({
      pair,
      nowMs: 1_800_000_006_000,
      maxFreshnessLagMs: 10_000,
    });

    expect(tick?.pythLazerId).to.equal(922);
    expect(tick?.priceUsd).to.be.closeTo(193.45, 1e-12);
    expect(tick?.confidenceUsd).to.be.closeTo(0.012, 1e-12);
    expect(tick?.feedUpdateTimestampUs).to.equal(1_800_000_000_000_000);
    expect(tick?.freshnessLagMs).to.equal(6_000);
    expect(tick?.isFresh).to.equal(true);
    expect(fetches[1]).to.contain("ids[]=abc123");
  });

  it("returns null when no Hermes mapping exists", async () => {
    const client = new PythSnapshotClient({
      lazerSymbolsUrl: "https://lazer.example/symbols",
      fetchImpl: (async () => jsonResponse([])) as typeof fetch,
    });

    const tick = await client.latestForPair({
      pair,
      nowMs: 1_800_000_006_000,
      maxFreshnessLagMs: 10_000,
    });

    expect(tick).to.equal(null);
  });
});

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}
