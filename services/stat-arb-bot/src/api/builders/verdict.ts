/** Assemble the inputs for a `buildResearchVerdict` call.
 *
 *  Token validation is the only input the bot can't fully provide yet (it
 *  requires a Solana RPC fetch — Phase 6 in the holistic review). For now we
 *  return `DECIMALS_CONFIG_ONLY` if the configured decimals look sane, which
 *  the verdict surfaces as a non-critical blocker. The next agent can swap
 *  the implementation without touching the rest of the API. */

import type {
  CostInputsBps,
  HoldHorizonReplayRow,
  PairConfig,
  PairReadinessMatrix,
  PairStatSummary,
  QuoteQualityDistributionDto,
  RouteStabilitySummary,
} from "@sotama/market-core";
import {
  buildResearchVerdict,
  type PairResearchVerdict,
  type TokenValidationSnapshot,
} from "@sotama/market-core";

export type VerdictInputs = {
  pair: PairConfig;
  pairReadiness: PairReadinessMatrix;
  qualityDistribution: readonly QuoteQualityDistributionDto[];
  holdHorizonReplay: readonly HoldHorizonReplayRow[];
  statSummary: readonly PairStatSummary[];
  routeStability: RouteStabilitySummary;
  costInputsBps: CostInputsBps;
  cleanWindowMs: number;
};

export function deriveTokenValidation(pair: PairConfig): TokenValidationSnapshot {
  const decimalsValid =
    Number.isInteger(pair.tokenized.decimals) &&
    pair.tokenized.decimals >= 0 &&
    pair.tokenized.decimals <= 18 &&
    pair.quote.decimals === 6;
  if (!decimalsValid) {
    return {
      status: "REJECTED",
      mint: pair.tokenized.mint,
      decimals: pair.tokenized.decimals,
      tokenProgram: null,
      reason: "Configured decimals are out of range — token mint cannot be safely quoted.",
    };
  }
  return {
    status: "DECIMALS_CONFIG_ONLY",
    mint: pair.tokenized.mint,
    decimals: pair.tokenized.decimals,
    tokenProgram: null,
    reason:
      "Decimals match config but mint account has not been fetched on-chain " +
      "(Solana RPC integration pending).",
  };
}

export function buildVerdictFor(inputs: VerdictInputs): {
  verdict: PairResearchVerdict;
  tokenValidation: TokenValidationSnapshot;
} {
  const tokenValidation = deriveTokenValidation(inputs.pair);
  const verdict = buildResearchVerdict({
    pair: inputs.pair,
    pairReadiness: inputs.pairReadiness,
    qualityDistribution: inputs.qualityDistribution,
    holdHorizonReplay: inputs.holdHorizonReplay,
    statSummary: inputs.statSummary,
    routeStability: inputs.routeStability,
    tokenValidation,
    costScenarioName: "BASE",
    cleanWindowMs: inputs.cleanWindowMs,
  });
  return { verdict, tokenValidation };
}

/** Compact one-liner used by the overview cards to highlight the most
 *  important issue without rendering the whole verdict panel. */
export function primaryBlockerSummary(
  verdict: PairResearchVerdict,
): string | null {
  if (verdict.blockers.length === 0) return null;
  const first = verdict.blockers[0]!;
  return first.detail;
}
