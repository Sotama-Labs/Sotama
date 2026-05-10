import assert from "node:assert/strict";
import { classifyChainLink, validateChainDraft } from "../src/lib/linked-chains";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TKN = "TKnxxx111111111111111111111111111111111111";

function tok(mint: string) {
  return { mint, symbol: "X", name: "X", decimals: 6, metadataSource: "manual" as const };
}

function swap(inMint: string, outMint: string) {
  return {
    triggers: [],
    triggerOperators: [],
    actions: [
      { kind: "swap" as const, inputToken: tok(inMint), outputToken: tok(outMint), amount: 1 },
    ],
    actionOperators: [],
    cadence: { kind: "once" as const },
    minIntervalSecs: 0,
  };
}

describe("classifyChainLink", () => {
  it("matched_mints when upstream.out == downstream.in", () => {
    assert.equal(classifyChainLink(swap(USDC, TKN), swap(TKN, SOL)), "matched_mints");
  });

  it("inverted_pair when A→B then B→A", () => {
    assert.equal(classifyChainLink(swap(USDC, TKN), swap(TKN, USDC)), "inverted_pair");
  });

  it("bridge_required when neither matches", () => {
    assert.equal(classifyChainLink(swap(USDC, TKN), swap(SOL, USDC)), "bridge_required");
  });

  it("matched_mints for degenerate same-token swap (USDC→USDC then USDC→USDC)", () => {
    assert.equal(classifyChainLink(swap(USDC, USDC), swap(USDC, USDC)), "matched_mints");
  });

  it("bridge_required for non-swap action", () => {
    const nonSwap = {
      triggers: [],
      triggerOperators: [],
      actions: [{ kind: "transfer" as const, amount: 1 }],
      actionOperators: [],
      cadence: { kind: "once" as const },
      minIntervalSecs: 0,
    };
    assert.equal(classifyChainLink(nonSwap as never, swap(USDC, TKN)), "bridge_required");
  });
});

describe("validateChainDraft (post-bridge)", () => {
  it("accepts a non-matching-mint chain (bridge handles it)", () => {
    const nodes = [
      { result: swap(USDC, TKN), next: { kind: "rule" as const, ruleIndex: 1 } },
      { result: swap(SOL, USDC), next: null },
    ];
    assert.equal(validateChainDraft(nodes), null);
  });

  it("still rejects non-swap actions in chain rules", () => {
    const nonSwap = {
      ...swap(USDC, TKN),
      actions: [{ kind: "transfer" as const, token: tok(USDC), amount: 1, destination: "x" }],
    };
    const err = validateChainDraft([{ result: nonSwap, next: null }]);
    assert.equal(err?.kind, "non_swap_action");
  });

  it("accepts multi-card self-link with mismatched mints (bridge will refill)", () => {
    // Rule 1 USDC→TKN feeds Rule 2 TKN→USDC, and Rule 2 self-links so
    // its USDC output is bridged back into TKN before the next fire.
    const nodes = [
      { result: swap(USDC, TKN), next: { kind: "rule" as const, ruleIndex: 1 } },
      { result: swap(TKN, USDC), next: { kind: "rule" as const, ruleIndex: 1 } },
    ];
    assert.equal(validateChainDraft(nodes), null);
  });
});
