import { expect } from "chai";
import { loadConfig } from "../src/config";

const base = {
  DATABASE_URL: "postgres://x:y@h/db",
  PYTH_LAZER_ACCESS_TOKEN: "token",
};

describe("loadConfig", () => {
  it("rejects missing DATABASE_URL", () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined } as any)).to.throw();
  });

  it("rejects missing Pyth Lazer token", () => {
    expect(() => loadConfig({ ...base, PYTH_LAZER_ACCESS_TOKEN: "" } as any)).to.throw();
  });

  it("auto-selects Jupiter Lite URL when no API key is set", () => {
    const cfg = loadConfig(base as any);
    expect(cfg.jupiterBaseUrl).to.equal("https://lite-api.jup.ag");
  });

  it("auto-selects Jupiter Pro URL when JUPITER_API_KEY is set", () => {
    const cfg = loadConfig({ ...base, JUPITER_API_KEY: "k" } as any);
    expect(cfg.jupiterBaseUrl).to.equal("https://api.jup.ag");
  });

  it("respects an explicit JUPITER_BASE_URL override", () => {
    const cfg = loadConfig({
      ...base,
      JUPITER_API_KEY: "k",
      JUPITER_BASE_URL: "https://custom.jup.example",
    } as any);
    expect(cfg.jupiterBaseUrl).to.equal("https://custom.jup.example");
  });

  it("accepts Helius URLs", () => {
    const cfg = loadConfig({
      ...base,
      HELIUS_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=xxx",
      HELIUS_WS_URL: "wss://mainnet.helius-rpc.com/?api-key=xxx",
    } as any);
    expect(cfg.HELIUS_RPC_URL).to.equal("https://mainnet.helius-rpc.com/?api-key=xxx");
    expect(cfg.HELIUS_WS_URL).to.equal("wss://mainnet.helius-rpc.com/?api-key=xxx");
  });

  it("rejects a non-URL JUPITER_BASE_URL", () => {
    expect(() =>
      loadConfig({ ...base, JUPITER_BASE_URL: "not-a-url" } as any),
    ).to.throw();
  });
});
