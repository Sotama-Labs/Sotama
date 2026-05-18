/** Statistical summary — answers "is the onchain/underlying ratio statistically
 *  far from its own equilibrium right now, and how persistent are those
 *  excursions?"
 *
 *  Computed per (pair, side, sizeUsd, window). Live-eligible observations only.
 *  The fair ratio defaults to the rolling median of the window — robust to the
 *  fat tails the doc warns about (stale-reference periods, route failures, open
 *  and close auctions for tokenized equities). Deviation is measured *from the
 *  fair ratio*, not from 1.0000; bridged crypto pairs that persistently trade
 *  at a small basis won't be miscategorized as constant alpha. */

import type { PairDirection } from "./pair-config";
import type { QuoteQualityStatus } from "./quote-quality";
import type { TimeRegime } from "./time-regime";

export type StatObservation = {
  side: PairDirection;
  sizeUsd: number;
  observedAtMs: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  qualityStatus: QuoteQualityStatus | null | undefined;
  timeRegime?: TimeRegime | null;
};

export type DeviationQuantilesBps = {
  p01: number | null;
  p05: number | null;
  p10: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
};

export type RegimeStatSummary = {
  regime: TimeRegime;
  fairRatio: number | null;
  liveSampleCount: number;
  medianDeviationBps: number | null;
  p05DeviationBps: number | null;
  p95DeviationBps: number | null;
};

export type PairStatSummary = {
  windowMs: number;
  side: PairDirection;
  sizeUsd: number;
  liveSampleCount: number;
  fairRatio: number | null;
  currentRatio: number | null;
  currentDeviationBps: number | null;
  meanRatio: number | null;
  medianRatio: number | null;
  ratioMad: number | null;
  meanDeviationBps: number | null;
  medianDeviationBps: number | null;
  deviationQuantilesBps: DeviationQuantilesBps;
  currentZScore: number | null;
  robustZScore: number | null;
  basisVolBps: number | null;
  skewBps: number | null;
  cheapTailCount: number;
  richTailCount: number;
  halfLifeSeconds: number | null;
  opportunityCount: number;
  avgOpportunityDurationSeconds: number | null;
  regimeBreakdown: RegimeStatSummary[];
};

export type StatSummaryOptions = {
  windowMs: number;
  /** Threshold (in bps) above which a deviation row counts as an opportunity. */
  opportunityThresholdBps?: number;
  /** Minimum samples required before half-life is reported. Smaller samples
   *  produce noisy regressions; below this we return null. */
  minHalfLifeSamples?: number;
};

const DEFAULT_OPPORTUNITY_THRESHOLD_BPS = 50;
const DEFAULT_MIN_HALF_LIFE_SAMPLES = 30;

export function buildStatSummary(args: {
  side: PairDirection;
  sizeUsd: number;
  observations: readonly StatObservation[];
  nowMs: number;
  options: StatSummaryOptions;
}): PairStatSummary {
  const opportunityThresholdBps =
    args.options.opportunityThresholdBps ?? DEFAULT_OPPORTUNITY_THRESHOLD_BPS;
  const minHalfLifeSamples =
    args.options.minHalfLifeSamples ?? DEFAULT_MIN_HALF_LIFE_SAMPLES;

  const cutoffMs = args.nowMs - args.options.windowMs;
  const live = args.observations
    .filter(
      (row) =>
        row.side === args.side &&
        row.sizeUsd === args.sizeUsd &&
        row.qualityStatus === "LIVE_ELIGIBLE" &&
        row.observedAtMs >= cutoffMs &&
        row.basePriceUsd > 0 &&
        row.tokenPriceUsd > 0,
    )
    .sort((a, b) => a.observedAtMs - b.observedAtMs);

  if (live.length === 0) {
    return emptySummary(args.side, args.sizeUsd, args.options.windowMs);
  }

  const ratios = live.map((row) => row.tokenPriceUsd / row.basePriceUsd);
  const meanRatio = mean(ratios);
  const medianRatio = median(ratios);
  const fairRatio = medianRatio;
  const ratioMad = medianAbsoluteDeviation(ratios, medianRatio);
  const deviationsBps = fairRatio == null
    ? []
    : ratios.map((ratio) => (ratio / fairRatio - 1) * 10_000);

  const meanDeviationBps = mean(deviationsBps);
  const medianDeviationBps = median(deviationsBps);
  const deviationQuantilesBps = computeQuantiles(deviationsBps);
  const stddev = standardDeviation(deviationsBps);
  const robustScale = ratioMad != null && fairRatio != null
    ? (ratioMad / fairRatio) * 10_000 * 1.4826 // 1.4826 → MAD → σ for normal data
    : null;

  const currentRatio = ratios[ratios.length - 1] ?? null;
  const currentDeviationBps = deviationsBps[deviationsBps.length - 1] ?? null;
  const currentZScore =
    currentDeviationBps == null || stddev == null || stddev === 0
      ? null
      : currentDeviationBps / stddev;
  const robustZScore =
    currentDeviationBps == null || robustScale == null || robustScale === 0
      ? null
      : currentDeviationBps / robustScale;

  const cheapTailCount = deviationsBps.filter(
    (bps) => bps <= -opportunityThresholdBps,
  ).length;
  const richTailCount = deviationsBps.filter(
    (bps) => bps >= opportunityThresholdBps,
  ).length;
  const skewBps = computeTailSkewBps(deviationsBps);

  const halfLifeSeconds =
    live.length >= minHalfLifeSamples
      ? estimateHalfLifeSeconds(deviationsBps, live.map((row) => row.observedAtMs))
      : null;

  const { opportunityCount, avgOpportunityDurationSeconds } =
    summarizeOpportunities(
      deviationsBps,
      live.map((row) => row.observedAtMs),
      opportunityThresholdBps,
    );

  const regimeBreakdown = buildRegimeBreakdown(live);

  return {
    windowMs: args.options.windowMs,
    side: args.side,
    sizeUsd: args.sizeUsd,
    liveSampleCount: live.length,
    fairRatio,
    currentRatio,
    currentDeviationBps,
    meanRatio,
    medianRatio,
    ratioMad,
    meanDeviationBps,
    medianDeviationBps,
    deviationQuantilesBps,
    currentZScore,
    robustZScore,
    basisVolBps: stddev,
    skewBps,
    cheapTailCount,
    richTailCount,
    halfLifeSeconds,
    opportunityCount,
    avgOpportunityDurationSeconds,
    regimeBreakdown,
  };
}

function emptySummary(
  side: PairDirection,
  sizeUsd: number,
  windowMs: number,
): PairStatSummary {
  return {
    windowMs,
    side,
    sizeUsd,
    liveSampleCount: 0,
    fairRatio: null,
    currentRatio: null,
    currentDeviationBps: null,
    meanRatio: null,
    medianRatio: null,
    ratioMad: null,
    meanDeviationBps: null,
    medianDeviationBps: null,
    deviationQuantilesBps: emptyQuantiles(),
    currentZScore: null,
    robustZScore: null,
    basisVolBps: null,
    skewBps: null,
    cheapTailCount: 0,
    richTailCount: 0,
    halfLifeSeconds: null,
    opportunityCount: 0,
    avgOpportunityDurationSeconds: null,
    regimeBreakdown: [],
  };
}

function emptyQuantiles(): DeviationQuantilesBps {
  return { p01: null, p05: null, p10: null, p50: null, p90: null, p95: null, p99: null };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m == null) return null;
  let sq = 0;
  for (const v of values) sq += (v - m) * (v - m);
  return Math.sqrt(sq / (values.length - 1));
}

function medianAbsoluteDeviation(
  values: readonly number[],
  med: number | null,
): number | null {
  if (med == null || values.length === 0) return null;
  return median(values.map((v) => Math.abs(v - med)));
}

function computeQuantiles(values: readonly number[]): DeviationQuantilesBps {
  if (values.length === 0) return emptyQuantiles();
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p01: quantile(sorted, 0.01),
    p05: quantile(sorted, 0.05),
    p10: quantile(sorted, 0.10),
    p50: quantile(sorted, 0.50),
    p90: quantile(sorted, 0.90),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
  };
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const loV = sorted[lo]!;
  const hiV = sorted[hi]!;
  return loV + (hiV - loV) * (idx - lo);
}

/** Crude skew indicator: the difference between the median absolute size of
 *  cheap-side excursions and rich-side excursions. Positive → onchain-rich
 *  tails are larger than onchain-cheap tails on average. */
function computeTailSkewBps(deviationsBps: readonly number[]): number | null {
  if (deviationsBps.length === 0) return null;
  const cheap = deviationsBps.filter((b) => b < 0).map((b) => Math.abs(b));
  const rich = deviationsBps.filter((b) => b > 0);
  if (cheap.length === 0 && rich.length === 0) return null;
  const cheapMed = cheap.length === 0 ? 0 : median(cheap)!;
  const richMed = rich.length === 0 ? 0 : median(rich)!;
  return richMed - cheapMed;
}

/** Simple AR(1) half-life via lagged regression: `Δdev = -k·dev_prev + ε`.
 *  Returns null when the slope is non-mean-reverting or scaling is degenerate. */
function estimateHalfLifeSeconds(
  deviationsBps: readonly number[],
  observedAtMs: readonly number[],
): number | null {
  if (deviationsBps.length < 2) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 1; i < deviationsBps.length; i += 1) {
    const prev = deviationsBps[i - 1]!;
    const delta = deviationsBps[i]! - prev;
    xs.push(prev);
    ys.push(delta);
  }
  const slope = linearRegressionSlope(xs, ys);
  if (slope == null || slope >= 0) return null;
  const k = -slope;
  if (k <= 0) return null;
  // Average tick spacing in seconds — half-life is reported in seconds so it
  // is comparable across pairs with different quote cadences.
  const tickSeconds = avgTickSpacingSeconds(observedAtMs);
  if (tickSeconds == null) return null;
  return (Math.log(2) / k) * tickSeconds;
}

function linearRegressionSlope(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n === 0 || n !== ys.length) return null;
  const xMean = mean(xs)!;
  const yMean = mean(ys)!;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - xMean;
    num += dx * (ys[i]! - yMean);
    den += dx * dx;
  }
  if (den === 0) return null;
  return num / den;
}

function avgTickSpacingSeconds(observedAtMs: readonly number[]): number | null {
  if (observedAtMs.length < 2) return null;
  let sumMs = 0;
  let count = 0;
  for (let i = 1; i < observedAtMs.length; i += 1) {
    const d = observedAtMs[i]! - observedAtMs[i - 1]!;
    if (d > 0) {
      sumMs += d;
      count += 1;
    }
  }
  if (count === 0) return null;
  return sumMs / count / 1000;
}

function summarizeOpportunities(
  deviationsBps: readonly number[],
  observedAtMs: readonly number[],
  thresholdBps: number,
): { opportunityCount: number; avgOpportunityDurationSeconds: number | null } {
  if (deviationsBps.length === 0) {
    return { opportunityCount: 0, avgOpportunityDurationSeconds: null };
  }
  let inOpportunity = false;
  let opportunityStartIdx = 0;
  let count = 0;
  let durationSumSeconds = 0;
  for (let i = 0; i < deviationsBps.length; i += 1) {
    const above = Math.abs(deviationsBps[i]!) >= thresholdBps;
    if (above && !inOpportunity) {
      inOpportunity = true;
      opportunityStartIdx = i;
    } else if (!above && inOpportunity) {
      inOpportunity = false;
      count += 1;
      const durMs = observedAtMs[i - 1]! - observedAtMs[opportunityStartIdx]!;
      durationSumSeconds += Math.max(0, durMs) / 1000;
    }
  }
  if (inOpportunity) {
    count += 1;
    const durMs =
      observedAtMs[deviationsBps.length - 1]! - observedAtMs[opportunityStartIdx]!;
    durationSumSeconds += Math.max(0, durMs) / 1000;
  }
  return {
    opportunityCount: count,
    avgOpportunityDurationSeconds: count === 0 ? null : durationSumSeconds / count,
  };
}

function buildRegimeBreakdown(observations: readonly StatObservation[]): RegimeStatSummary[] {
  const grouped = new Map<TimeRegime, StatObservation[]>();
  for (const row of observations) {
    if (row.timeRegime == null) continue;
    const list = grouped.get(row.timeRegime) ?? [];
    list.push(row);
    grouped.set(row.timeRegime, list);
  }
  return [...grouped.entries()]
    .map(([regime, rows]) => {
      const ratios = rows.map((row) => row.tokenPriceUsd / row.basePriceUsd);
      const fairRatio = median(ratios);
      const devs =
        fairRatio == null
          ? []
          : ratios.map((r) => (r / fairRatio - 1) * 10_000);
      return {
        regime,
        fairRatio,
        liveSampleCount: rows.length,
        medianDeviationBps: median(devs),
        p05DeviationBps: devs.length === 0 ? null : quantile([...devs].sort((a, b) => a - b), 0.05),
        p95DeviationBps: devs.length === 0 ? null : quantile([...devs].sort((a, b) => a - b), 0.95),
      };
    })
    .sort((a, b) => b.liveSampleCount - a.liveSampleCount);
}
