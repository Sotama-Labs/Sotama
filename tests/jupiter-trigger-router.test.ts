import { expect } from "chai";
import { routeAutomation } from "../src/lib/jupiter-trigger-router";
import type {
  Automation,
  AssetPriceTrigger,
  AssetRef,
  SwapAction,
  TokenRef,
  TransferAction,
} from "../src/lib/types";

const JUP_MINT = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";

const JUP_ASSET: AssetRef = {
  symbol: "JUP",
  displaySymbol: "JUP",
  name: "Jupiter",
  assetClass: "Crypto",
  mint: JUP_MINT,
  decimals: 6,
};

const USDC: TokenRef = {
  mint: USDC_MINT,
  symbol: "USDC",
  name: "USD Coin",
  decimals: 6,
  metadataSource: "canonical",
};

const JUP: TokenRef = {
  mint: JUP_MINT,
  symbol: "JUP",
  name: "Jupiter",
  decimals: 6,
  metadataSource: "canonical",
};

const SOL: TokenRef = {
  mint: SOL_MINT,
  symbol: "SOL",
  name: "Solana",
  decimals: 9,
  metadataSource: "canonical",
};

function makeAuto(overrides: Partial<Automation> = {}): Automation {
  const trigger: AssetPriceTrigger = {
    kind: "asset_price",
    asset: JUP_ASSET,
    quote: { kind: "usd" },
    comparator: "below",
    threshold: 0.025,
    oracle: { kind: "jupiter", mint: JUP_MINT, symbol: "JUP" },
  };
  const action: SwapAction = {
    kind: "swap",
    inputToken: USDC,
    outputToken: JUP,
    amount: 100,
  };
  return {
    id: "a_test",
    schemaVersion: 3,
    triggers: [trigger],
    triggerOperators: [],
    actions: [action],
    actionOperators: [],
    cadence: { kind: "once" },
    minIntervalSecs: 0,
    running: true,
    runs: 0,
    lastCheck: "now",
    createdAt: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("routeAutomation", () => {
  it("delegates simple USD-threshold buy to Jupiter Trigger v2", () => {
    const decision = routeAutomation(makeAuto());
    expect(decision.route).to.equal("jupiter_trigger");
    if (decision.route !== "jupiter_trigger") return;
    expect(decision.params).to.deep.equal({
      inputMint: USDC_MINT,
      outputMint: JUP_MINT,
      triggerMint: JUP_MINT,
      triggerCondition: "below",
      triggerPriceUsd: 0.025,
      inputAmount: "100000000", // 100 * 10^6
    });
  });

  it("delegates a sell (trigger on input mint) to Jupiter", () => {
    const decision = routeAutomation(
      makeAuto({
        triggers: [
          {
            kind: "asset_price",
            asset: JUP_ASSET,
            quote: { kind: "usd" },
            comparator: "above",
            threshold: 1.5,
            oracle: { kind: "jupiter", mint: JUP_MINT, symbol: "JUP" },
          },
        ],
        actions: [{ kind: "swap", inputToken: JUP, outputToken: USDC, amount: 50 }],
      }),
    );
    expect(decision.route).to.equal("jupiter_trigger");
    if (decision.route !== "jupiter_trigger") return;
    expect(decision.params.triggerCondition).to.equal("above");
    expect(decision.params.inputMint).to.equal(JUP_MINT);
    expect(decision.params.outputMint).to.equal(USDC_MINT);
    expect(decision.params.inputAmount).to.equal("50000000");
  });

  it("preserves SOL's 9 decimals in the smallest-unit conversion", () => {
    const decision = routeAutomation(
      makeAuto({
        triggers: [
          {
            kind: "asset_price",
            asset: { ...JUP_ASSET, mint: SOL_MINT, symbol: "SOL", displaySymbol: "SOL", decimals: 9 },
            quote: { kind: "usd" },
            comparator: "below",
            threshold: 100,
            oracle: { kind: "jupiter", mint: SOL_MINT, symbol: "SOL" },
          },
        ],
        actions: [{ kind: "swap", inputToken: USDC, outputToken: SOL, amount: 25 }],
      }),
    );
    expect(decision.route).to.equal("jupiter_trigger");
    if (decision.route !== "jupiter_trigger") return;
    expect(decision.params.inputAmount).to.equal("25000000");
  });

  describe("falls back to keeper", () => {
    it("multi-trigger composition", () => {
      const t1: AssetPriceTrigger = makeAuto().triggers[0] as AssetPriceTrigger;
      const decision = routeAutomation(
        makeAuto({ triggers: [t1, t1], triggerOperators: ["and"] }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "multiple_triggers" });
    });

    it("multi-action sequence", () => {
      const transfer: TransferAction = {
        kind: "transfer",
        token: USDC,
        amount: 1,
        destination: "Sotama1111111111111111111111111111111111111",
      };
      const decision = routeAutomation(
        makeAuto({
          actions: [makeAuto().actions[0], transfer],
          actionOperators: ["then"],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "multiple_actions" });
    });

    it("non-asset-price trigger (account_swap)", () => {
      const decision = routeAutomation(
        makeAuto({
          triggers: [
            {
              kind: "account_swap",
              account: "Sotama1111111111111111111111111111111111111",
              token: { mode: "any" },
              amount: { mode: "any" },
              amountDirection: "at_least",
            },
          ],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "trigger_not_asset_price" });
    });

    it("transfer action instead of swap", () => {
      const decision = routeAutomation(
        makeAuto({
          actions: [
            {
              kind: "transfer",
              token: USDC,
              amount: 5,
              destination: "Sotama1111111111111111111111111111111111111",
            },
          ],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "action_not_swap" });
    });

    it("repeat cadence (For loop)", () => {
      const decision = routeAutomation(
        makeAuto({ cadence: { kind: "repeat", total: 5 } }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "looped_cadence" });
    });

    it("until cadence (While loop)", () => {
      const decision = routeAutomation(
        makeAuto({ cadence: { kind: "until", unixDeadline: 9999999999 } }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "looped_cadence" });
    });

    it("linked-downstream chain", () => {
      const swap: SwapAction = {
        kind: "swap",
        inputToken: USDC,
        outputToken: JUP,
        amount: 100,
        linkedDownstream: "DownstreamAuto11111111111111111111111111111",
      };
      const decision = routeAutomation(makeAuto({ actions: [swap] }));
      expect(decision).to.deep.equal({ route: "keeper", reason: "linked_downstream" });
    });

    it("non-USD quote (asset-vs-asset ratio)", () => {
      const decision = routeAutomation(
        makeAuto({
          triggers: [
            {
              kind: "asset_price",
              asset: JUP_ASSET,
              quote: {
                kind: "asset",
                asset: {
                  symbol: "SOL",
                  displaySymbol: "SOL",
                  name: "Solana",
                  assetClass: "Crypto",
                  mint: SOL_MINT,
                  decimals: 9,
                },
              },
              comparator: "below",
              threshold: 0.001,
              oracle: { kind: "jupiter", mint: JUP_MINT, symbol: "JUP" },
            },
          ],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "quote_not_usd" });
    });

    it("non-Crypto asset class (Equity)", () => {
      const decision = routeAutomation(
        makeAuto({
          triggers: [
            {
              kind: "asset_price",
              asset: {
                symbol: "US.NVDA",
                displaySymbol: "NVDA",
                name: "NVIDIA",
                assetClass: "Equity",
              },
              quote: { kind: "usd" },
              comparator: "above",
              threshold: 1000,
              oracle: { kind: "pyth", feedId: "0xabc", symbol: "NVDA/USD" },
            },
          ],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "asset_not_crypto" });
    });

    it("Crypto asset without an SPL mint", () => {
      const decision = routeAutomation(
        makeAuto({
          triggers: [
            {
              kind: "asset_price",
              asset: { ...JUP_ASSET, mint: undefined },
              quote: { kind: "usd" },
              comparator: "below",
              threshold: 0.025,
              oracle: { kind: "jupiter", mint: JUP_MINT, symbol: "JUP" },
            },
          ],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "trigger_asset_no_mint" });
    });

    it("trigger mint not on either swap leg", () => {
      const decision = routeAutomation(
        makeAuto({
          actions: [{ kind: "swap", inputToken: USDC, outputToken: SOL, amount: 100 }],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "trigger_mint_not_in_swap" });
    });

    it("input == output mint (no-op swap)", () => {
      const decision = routeAutomation(
        makeAuto({
          triggers: [
            {
              kind: "asset_price",
              asset: { ...JUP_ASSET, mint: USDC_MINT, symbol: "USDC", displaySymbol: "USDC" },
              quote: { kind: "usd" },
              comparator: "above",
              threshold: 1,
              oracle: { kind: "jupiter", mint: USDC_MINT, symbol: "USDC" },
            },
          ],
          actions: [{ kind: "swap", inputToken: USDC, outputToken: USDC, amount: 1 }],
        }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "swap_same_input_output" });
    });

    it("zero amount", () => {
      const decision = routeAutomation(
        makeAuto({ actions: [{ kind: "swap", inputToken: USDC, outputToken: JUP, amount: 0 }] }),
      );
      expect(decision).to.deep.equal({ route: "keeper", reason: "non_positive_amount" });
    });
  });
});
