import assert from "node:assert/strict";
import { classifyChainLink } from "../src/lib/linked-chains";

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

  it("matched_mints wins over inverted_pair when both could apply", () => {
    assert.equal(classifyChainLink(swap(USDC, USDC), swap(USDC, USDC)), "matched_mints");
  });
});
