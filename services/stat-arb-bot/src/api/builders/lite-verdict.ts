/** Lightweight pair verdict for the overview page.
 *
 *  The full `buildResearchVerdict` needs basisHistory, hold-horizon replay,
 *  stat summaries, and route stability — far too heavy to compute for every
 *  pair on every dashboard poll. The overview only needs to bucket pairs
 *  into the verdict groups; the detail page recomputes the full verdict.
 *
 *  Lite verdict status mapping:
 *    NOT_READY    — token mint rejected, no live samples, or no quotes
 *    COLLECT_MORE — live samples < threshold (default 200)
 *    PAPER_EDGE   — enough live samples; full verdict needed to differentiate
 *                   PAPER_EDGE vs CANDIDATE vs NO_EDGE → tap to view detail
 *
 *  We intentionally never emit `CANDIDATE` from lite verdict — promoting a
 *  pair to "candidate" requires hold-horizon + route-stability evidence the
 *  lite path does not have. */

import type {
  PairConfig,
  PairResearchVerdict,
  QuoteQualityDistributionDto,
  TokenValidationSnapshot,
} from "@sotama/market-core";

export type LiteVerdictInputs = {
  pair: PairConfig;
  qualityDistribution: readonly QuoteQualityDistributionDto[];
  tokenValidation: TokenValidationSnapshot;
  /** Minimum live-eligible samples before promoting past COLLECT_MORE. */
  minCleanSamples?: number;
  /** Window the live-sample count was measured over. */
  cleanWindowMs: number;
};

const DEFAULT_MIN_CLEAN_SAMPLES = 200;

export function buildLiteVerdict(input: LiteVerdictInputs): PairResearchVerdict {
  const minCleanSamples = input.minCleanSamples ?? DEFAULT_MIN_CLEAN_SAMPLES;
  const cleanSampleCount = liveEligibleCount(input.qualityDistribution);

  const blockers: PairResearchVerdict["blockers"] = [];
  const positives: PairResearchVerdict["positives"] = [];

  if (input.tokenValidation.status === "REJECTED") {
    blockers.push({
      code: "TOKEN_MINT_REJECTED",
      detail: input.tokenValidation.reason,
    });
  } else if (input.tokenValidation.status !== "VERIFIED_ONCHAIN") {
    blockers.push({
      code: "TOKEN_MINT_UNVERIFIED",
      detail: input.tokenValidation.reason,
    });
  } else {
    positives.push({
      code: "TOKEN_MINT_VERIFIED",
      detail: `mint verified on-chain (decimals ${input.tokenValidation.decimals})`,
    });
  }

  if (cleanSampleCount === 0) {
    blockers.push({
      code: "NO_LIVE_SAMPLES",
      detail: "no live-eligible observations in the window",
    });
  }

  if (blockers.some((b) => b.code === "TOKEN_MINT_REJECTED")) {
    return {
      status: "NOT_READY",
      confidence: "HIGH",
      summary: blockers[0]!.detail,
      blockers,
      positives,
      cleanSampleCount,
      cleanWindowMs: input.cleanWindowMs,
      costScenarioName: "BASE",
      recommendedNextAction:
        "Replace the tokenized mint or document the exception before re-enabling.",
    };
  }

  if (cleanSampleCount === 0) {
    return {
      status: "NOT_READY",
      confidence: "LOW",
      summary: "No live-eligible quotes yet — confirm feeds and routes.",
      blockers,
      positives,
      cleanSampleCount,
      cleanWindowMs: input.cleanWindowMs,
      costScenarioName: "BASE",
      recommendedNextAction: "Verify Pyth + Jupiter reachability for this pair.",
    };
  }

  if (cleanSampleCount < minCleanSamples) {
    return {
      status: "COLLECT_MORE",
      confidence: "LOW",
      summary: `${cleanSampleCount} live-eligible samples (need ${minCleanSamples}).`,
      blockers,
      positives,
      cleanSampleCount,
      cleanWindowMs: input.cleanWindowMs,
      costScenarioName: "BASE",
      recommendedNextAction: "Keep streaming; recheck in 24h.",
    };
  }

  return {
    status: "PAPER_EDGE",
    confidence: "LOW",
    summary: "Enough clean samples — open the pair page for the full verdict.",
    blockers,
    positives,
    cleanSampleCount,
    cleanWindowMs: input.cleanWindowMs,
    costScenarioName: "BASE",
    recommendedNextAction: "Open pair detail for hold-horizon, stat, and route evidence.",
  };
}

function liveEligibleCount(
  distribution: readonly QuoteQualityDistributionDto[],
): number {
  for (const row of distribution) {
    if (row.qualityStatus === "LIVE_ELIGIBLE") return row.observationCount;
  }
  return 0;
}
