import type { TimeRegime } from "./time-regime";

export type QuoteQualityStatus =
  | "LIVE_ELIGIBLE"
  | "STALE_PYTH"
  | "STALE_BASIS"
  | "QUOTE_LATENCY_TOO_HIGH"
  | "MISSING_EXIT_QUOTE"
  | "UNKNOWN_ROUTER"
  | "ROUTE_UNSTABLE"
  | "MARKET_SESSION_INVALID"
  | "PRICE_IMPACT_TOO_HIGH"
  | "PYTH_CONFIDENCE_TOO_WIDE"
  | "DECIMALS_UNVERIFIED";

export type QuoteQualityThresholds = {
  maxPythFreshnessLagMs: number;
  maxQuoteLatencyMs: number;
  maxBasisAgeMs: number;
  maxPriceImpactBps: number;
  maxPythConfidenceBps: number;
  allowedRouters: readonly string[];
  allowedMarketSessions: readonly TimeRegime[];
};

export type QuoteQualityOverrides = Partial<{
  maxPythFreshnessLagMs: number;
  maxQuoteLatencyMs: number;
  maxBasisAgeMs: number;
  maxPriceImpactBps: number;
  maxPythConfidenceBps: number;
  allowedRouters: readonly string[];
  allowedMarketSessions: readonly TimeRegime[];
}>;

export type QuoteQualityInput = {
  pythFreshnessLagMs: number | null | undefined;
  quoteRequestMs: number | null | undefined;
  basisAgeMs: number | null | undefined;
  priceImpactPct: number | null | undefined;
  pythConfidenceBps: number | null | undefined;
  router: string | null | undefined;
  timeRegime: TimeRegime | null | undefined;
  decimalsVerified: boolean;
  hasExitQuote?: boolean | null;
  routeStable?: boolean | null;
};

export type QuoteQualityResult = {
  qualityStatus: QuoteQualityStatus;
  qualityReason: string;
};

export const DEFAULT_ALLOWED_MARKET_SESSIONS: readonly TimeRegime[] = [
  "US_EQUITY_REGULAR",
  "METAL_ACTIVE",
  "CRYPTO_NORMAL",
  "CRYPTO_HIGH_VOL",
];

export const DEFAULT_QUOTE_QUALITY_THRESHOLDS: QuoteQualityThresholds = {
  maxPythFreshnessLagMs: 5_000,
  maxQuoteLatencyMs: 1_500,
  maxBasisAgeMs: 5_000,
  maxPriceImpactBps: 50,
  maxPythConfidenceBps: 25,
  allowedRouters: [],
  allowedMarketSessions: DEFAULT_ALLOWED_MARKET_SESSIONS,
};

export function buildQuoteQualityThresholds(
  overrides: QuoteQualityOverrides | null | undefined,
  fallback: QuoteQualityThresholds = DEFAULT_QUOTE_QUALITY_THRESHOLDS,
): QuoteQualityThresholds {
  return {
    maxPythFreshnessLagMs:
      overrides?.maxPythFreshnessLagMs ?? fallback.maxPythFreshnessLagMs,
    maxQuoteLatencyMs: overrides?.maxQuoteLatencyMs ?? fallback.maxQuoteLatencyMs,
    maxBasisAgeMs: overrides?.maxBasisAgeMs ?? fallback.maxBasisAgeMs,
    maxPriceImpactBps: overrides?.maxPriceImpactBps ?? fallback.maxPriceImpactBps,
    maxPythConfidenceBps:
      overrides?.maxPythConfidenceBps ?? fallback.maxPythConfidenceBps,
    allowedRouters: overrides?.allowedRouters ?? fallback.allowedRouters,
    allowedMarketSessions:
      overrides?.allowedMarketSessions ?? fallback.allowedMarketSessions,
  };
}

export function classifyQuoteQuality(
  input: QuoteQualityInput,
  thresholds: QuoteQualityThresholds,
): QuoteQualityResult {
  if (!input.decimalsVerified) {
    return reason("DECIMALS_UNVERIFIED", "token mint decimals have not been verified");
  }

  if (
    input.pythFreshnessLagMs == null ||
    input.pythFreshnessLagMs > thresholds.maxPythFreshnessLagMs
  ) {
    return reason(
      "STALE_PYTH",
      `pyth freshness ${fmt(input.pythFreshnessLagMs)}ms exceeds ${thresholds.maxPythFreshnessLagMs}ms`,
    );
  }

  if (input.basisAgeMs == null || input.basisAgeMs > thresholds.maxBasisAgeMs) {
    return reason(
      "STALE_BASIS",
      `basis age ${fmt(input.basisAgeMs)}ms exceeds ${thresholds.maxBasisAgeMs}ms`,
    );
  }

  if (
    input.quoteRequestMs == null ||
    input.quoteRequestMs > thresholds.maxQuoteLatencyMs
  ) {
    return reason(
      "QUOTE_LATENCY_TOO_HIGH",
      `quote latency ${fmt(input.quoteRequestMs)}ms exceeds ${thresholds.maxQuoteLatencyMs}ms`,
    );
  }

  if (!input.timeRegime || !thresholds.allowedMarketSessions.includes(input.timeRegime)) {
    return reason(
      "MARKET_SESSION_INVALID",
      `market regime ${input.timeRegime ?? "missing"} is not live-eligible`,
    );
  }

  const priceImpactBps =
    input.priceImpactPct == null ? null : Math.abs(input.priceImpactPct * 100);
  if (priceImpactBps == null || priceImpactBps > thresholds.maxPriceImpactBps) {
    return reason(
      "PRICE_IMPACT_TOO_HIGH",
      `price impact ${fmt(priceImpactBps)}bps exceeds ${thresholds.maxPriceImpactBps}bps`,
    );
  }

  if (
    input.pythConfidenceBps == null ||
    input.pythConfidenceBps > thresholds.maxPythConfidenceBps
  ) {
    return reason(
      "PYTH_CONFIDENCE_TOO_WIDE",
      `pyth confidence ${fmt(input.pythConfidenceBps)}bps exceeds ${thresholds.maxPythConfidenceBps}bps`,
    );
  }

  if (!input.router) {
    return reason("UNKNOWN_ROUTER", "Jupiter did not return a router");
  }
  if (
    thresholds.allowedRouters.length > 0 &&
    !thresholds.allowedRouters.includes(input.router)
  ) {
    return reason("UNKNOWN_ROUTER", `router ${input.router} is not allowlisted`);
  }

  if (input.routeStable === false) {
    return reason("ROUTE_UNSTABLE", "route changed beyond configured stability bounds");
  }

  if (input.hasExitQuote === false) {
    return reason("MISSING_EXIT_QUOTE", "opposite-side exit quote is unavailable");
  }

  return reason("LIVE_ELIGIBLE", "quote passed all live eligibility checks");
}

export function observationQualityFromStatus(
  status: QuoteQualityStatus,
): "live" | "warm" | "stale" | "invalid" {
  switch (status) {
    case "LIVE_ELIGIBLE":
      return "live";
    case "STALE_PYTH":
    case "STALE_BASIS":
      return "stale";
    case "QUOTE_LATENCY_TOO_HIGH":
      return "warm";
    default:
      return "invalid";
  }
}

function reason(
  qualityStatus: QuoteQualityStatus,
  qualityReason: string,
): QuoteQualityResult {
  return { qualityStatus, qualityReason };
}

function fmt(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "missing" : value.toFixed(2);
}
