/** Pair-level research verdict — the answer to "should we keep researching
 *  this pair?" rendered at the top of every pair page.
 *
 *      NOT_READY    — feed, route, or mint pre-conditions still failing
 *      COLLECT_MORE — feeds + routes are fine but live sample count is too small
 *      NO_EDGE      — enough clean data, replay does not survive costs
 *      PAPER_EDGE   — replay survives costs but coverage / confidence is low
 *      CANDIDATE    — clean data, stable routes, positive replay, manageable drawdown
 *
 *  The verdict is deterministic given its inputs — tests at this layer alone
 *  should catch every regression in how the dashboard scores a pair. */

import type { HoldHorizonReplayRow } from "./hold-horizon";
import type { PairConfig } from "./pair-config";
import type { PairReadinessMatrix } from "./pair-readiness";
import type { QuoteQualityStatus } from "./quote-quality";
import type { RouteStabilitySummary } from "./route-stability";
import type { PairStatSummary } from "./stat-summary";

/** Structural type the verdict consumes — kept local to avoid a market-core
 *  internal cycle with `api-dto.ts`. The bot's API layer passes the existing
 *  `QuoteQualityDistributionDto` rows directly. */
type QualityShare = {
  qualityStatus: QuoteQualityStatus;
  observationCount: number;
  observationPct: number;
};

export type PairResearchVerdictStatus =
  | "NOT_READY"
  | "COLLECT_MORE"
  | "NO_EDGE"
  | "PAPER_EDGE"
  | "CANDIDATE";

export type PairResearchVerdictConfidence = "LOW" | "MEDIUM" | "HIGH";

export type PairResearchVerdictReason = {
  code: string;
  detail: string;
};

export type PairResearchVerdict = {
  status: PairResearchVerdictStatus;
  confidence: PairResearchVerdictConfidence;
  summary: string;
  blockers: PairResearchVerdictReason[];
  positives: PairResearchVerdictReason[];
  cleanSampleCount: number;
  cleanWindowMs: number;
  costScenarioName: string;
  recommendedNextAction: string;
};

export type TokenValidationStatus =
  | "VERIFIED_ONCHAIN"
  | "DECIMALS_CONFIG_ONLY"
  | "UNVERIFIED"
  | "REJECTED";

export type TokenValidationSnapshot = {
  status: TokenValidationStatus;
  mint: string;
  decimals: number;
  tokenProgram: string | null;
  reason: string;
};

export type ResearchVerdictInputs = {
  pair: PairConfig;
  pairReadiness: PairReadinessMatrix;
  qualityDistribution: readonly QualityShare[];
  holdHorizonReplay: readonly HoldHorizonReplayRow[];
  statSummary: readonly PairStatSummary[];
  routeStability: RouteStabilitySummary;
  tokenValidation: TokenValidationSnapshot;
  costScenarioName: string;
  cleanWindowMs: number;
  /** Minimum live-eligible samples per primary (side, size) for `COLLECT_MORE`
   *  to advance to a profitability verdict. Defaults to 200. */
  minCleanSamples?: number;
  /** Required closed trades and positive horizons before `CANDIDATE`. */
  candidateMinClosedTrades?: number;
  candidateMinPositiveHorizons?: number;
};

const DEFAULT_MIN_CLEAN_SAMPLES = 200;
const DEFAULT_CANDIDATE_MIN_CLOSED_TRADES = 30;
const DEFAULT_CANDIDATE_MIN_POSITIVE_HORIZONS = 2;

export function buildResearchVerdict(input: ResearchVerdictInputs): PairResearchVerdict {
  const minCleanSamples = input.minCleanSamples ?? DEFAULT_MIN_CLEAN_SAMPLES;
  const candidateMinClosedTrades =
    input.candidateMinClosedTrades ?? DEFAULT_CANDIDATE_MIN_CLOSED_TRADES;
  const candidateMinPositiveHorizons =
    input.candidateMinPositiveHorizons ?? DEFAULT_CANDIDATE_MIN_POSITIVE_HORIZONS;

  const blockers: PairResearchVerdictReason[] = [];
  const positives: PairResearchVerdictReason[] = [];
  const cleanSampleCount = sumLiveEligible(input.qualityDistribution);

  if (!input.pair.enabled) {
    return {
      status: "NOT_READY",
      confidence: "LOW",
      summary: "Pair is paused; the bot is not scheduling feed or route probes.",
      blockers: [
        {
          code: "PAIR_DISABLED",
          detail: "Pair is paused; enable it before expecting Pyth updates or Jupiter route probes.",
        },
      ],
      positives,
      cleanSampleCount,
      cleanWindowMs: input.cleanWindowMs,
      costScenarioName: input.costScenarioName,
      recommendedNextAction: "Enable the pair after confirming the token mint and route are intended.",
    };
  }

  // ── Pre-conditions: routes, feeds, mint --------------------------
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

  if (input.pairReadiness.status === "NOT_READY") {
    const failing = input.pairReadiness.rows
      .filter((row) => row.status === "NOT_READY")
      .flatMap((row) => row.reasonCodes);
    blockers.push({
      code: "PAIR_READINESS_NOT_READY",
      detail: `pair readiness reports NOT_READY (${unique(failing).slice(0, 3).join(", ") || "no reasons"})`,
    });
  } else if (input.pairReadiness.status === "READY") {
    positives.push({
      code: "PAIR_READINESS_READY",
      detail: "every side/size passes feed, route, latency, and session checks",
    });
  }

  if (cleanSampleCount === 0) {
    blockers.push({
      code: "NO_LIVE_SAMPLES",
      detail: "no live-eligible observations in the window",
    });
  }

  if (!input.routeStability.routeStable && input.routeStability.totalOkCount > 0) {
    blockers.push({
      code: "ROUTE_UNSTABLE",
      detail: `${formatRouter(input.routeStability.topRouter)}; ${formatChanges(input.routeStability.routerChangesPerHour)} router changes/hr`,
    });
  } else if (input.routeStability.routeStable && input.routeStability.totalOkCount > 0) {
    positives.push({
      code: "ROUTE_STABLE",
      detail: `${formatRouter(input.routeStability.topRouter)} stable; ${formatChanges(input.routeStability.routerChangesPerHour)} switches/hr`,
    });
  }

  // ── Replay + statistics evidence ---------------------------------
  const horizonsWithCloses = input.holdHorizonReplay.filter(
    (row) => row.horizonCovered && row.closedTrades > 0,
  );
  const positiveHorizons = horizonsWithCloses.filter((row) => row.returnPct > 0);
  const totalClosedTrades = horizonsWithCloses.reduce(
    (acc, row) => acc + row.closedTrades,
    0,
  );

  const significantStatSummary = input.statSummary
    .filter((row) => row.liveSampleCount >= 30)
    .sort((a, b) => b.liveSampleCount - a.liveSampleCount)[0];

  if (significantStatSummary) {
    if (significantStatSummary.opportunityCount > 0) {
      positives.push({
        code: "REPEATABLE_OPPORTUNITIES",
        detail: `${significantStatSummary.opportunityCount} basis excursions ≥ threshold during window`,
      });
    }
    if (
      significantStatSummary.halfLifeSeconds != null &&
      significantStatSummary.halfLifeSeconds < 30 * 60
    ) {
      positives.push({
        code: "FAST_MEAN_REVERSION",
        detail: `half-life ${Math.round(significantStatSummary.halfLifeSeconds)}s (mean-reverting)`,
      });
    }
  }

  // ── Decide status -----------------------------------------------
  let status: PairResearchVerdictStatus = "COLLECT_MORE";
  let summary = "Collecting more clean samples before any profitability claim.";
  let recommendedNextAction = `Wait for ${minCleanSamples - cleanSampleCount} more live-eligible samples.`;

  if (blockers.some((b) => isCriticalBlocker(b.code))) {
    status = "NOT_READY";
    summary = blockers.find((b) => isCriticalBlocker(b.code))!.detail;
    recommendedNextAction = nextActionForBlocker(blockers);
  } else if (cleanSampleCount < minCleanSamples) {
    status = "COLLECT_MORE";
    summary = `${cleanSampleCount} live-eligible samples (need ${minCleanSamples}).`;
    recommendedNextAction = "Keep streaming; recheck in 24h.";
  } else if (horizonsWithCloses.length === 0) {
    status = "NO_EDGE";
    summary = "Enough clean data but replay has not produced a closed round-trip.";
    recommendedNextAction = "Inspect exit-quote availability; consider widening the entry threshold.";
  } else if (positiveHorizons.length === 0) {
    status = "NO_EDGE";
    summary = "Replay closed trades but none survived cost assumptions.";
    recommendedNextAction = "Review cost waterfall and route stability.";
  } else if (
    positiveHorizons.length >= candidateMinPositiveHorizons &&
    totalClosedTrades >= candidateMinClosedTrades &&
    input.pairReadiness.status === "READY" &&
    input.routeStability.routeStable
  ) {
    status = "CANDIDATE";
    summary = `Replay survives costs across ${positiveHorizons.length} horizons (${totalClosedTrades} trades) with stable routing.`;
    recommendedNextAction = "Promote to deeper out-of-sample testing and instrument live execution latency.";
  } else {
    status = "PAPER_EDGE";
    summary = `Replay shows positive horizons (${positiveHorizons.length}) but coverage is thin (${totalClosedTrades} trades).`;
    recommendedNextAction = "Continue collecting; track stat-summary z-score and opportunity persistence.";
  }

  const confidence = computeConfidence({
    cleanSampleCount,
    totalClosedTrades,
    routeStable: input.routeStability.routeStable,
    statHasHalfLife:
      significantStatSummary?.halfLifeSeconds != null &&
      significantStatSummary.halfLifeSeconds > 0,
    minCleanSamples,
  });

  return {
    status,
    confidence,
    summary,
    blockers,
    positives,
    cleanSampleCount,
    cleanWindowMs: input.cleanWindowMs,
    costScenarioName: input.costScenarioName,
    recommendedNextAction,
  };
}

function sumLiveEligible(distribution: readonly QualityShare[]): number {
  for (const row of distribution) {
    if (row.qualityStatus === "LIVE_ELIGIBLE") return row.observationCount;
  }
  return 0;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isCriticalBlocker(code: string): boolean {
  return (
    code === "PAIR_READINESS_NOT_READY" ||
    code === "TOKEN_MINT_REJECTED"
  );
}

function nextActionForBlocker(blockers: readonly PairResearchVerdictReason[]): string {
  const codes = new Set(blockers.map((b) => b.code));
  if (codes.has("TOKEN_MINT_REJECTED")) {
    return "Replace the tokenized mint or document the exception before re-enabling.";
  }
  if (codes.has("PAIR_READINESS_NOT_READY")) {
    return "Fix the feed, route, or decimals problem flagged by pair readiness.";
  }
  if (codes.has("NO_LIVE_SAMPLES")) {
    return "Confirm Pyth and Jupiter are reachable; the bot has not produced a live row.";
  }
  return "Resolve blockers before resuming research evaluation.";
}

function formatRouter(top: RouteStabilitySummary["topRouter"]): string {
  if (!top) return "no router observed";
  return `top router ${top.router} ${(top.pct * 100).toFixed(0)}%`;
}

function formatChanges(changes: number | null | undefined): string {
  return changes == null ? "n/a" : changes.toFixed(1);
}

function computeConfidence(args: {
  cleanSampleCount: number;
  totalClosedTrades: number;
  routeStable: boolean;
  statHasHalfLife: boolean;
  minCleanSamples: number;
}): PairResearchVerdictConfidence {
  let score = 0;
  if (args.cleanSampleCount >= args.minCleanSamples * 4) score += 2;
  else if (args.cleanSampleCount >= args.minCleanSamples) score += 1;
  if (args.totalClosedTrades >= 60) score += 2;
  else if (args.totalClosedTrades >= 20) score += 1;
  if (args.routeStable) score += 1;
  if (args.statHasHalfLife) score += 1;
  if (score >= 5) return "HIGH";
  if (score >= 3) return "MEDIUM";
  return "LOW";
}
