import type { PairConfig, PairDirection } from "./pair-config";
import type { QuoteQualityStatus } from "./quote-quality";
import type { TimeRegime } from "./time-regime";

export type PairReadinessStatus = "READY" | "RESEARCH_ONLY" | "NOT_READY";

export type PairReadinessReasonCode =
  | "PYTH_FEED_MISSING"
  | "NO_FEED_UPDATES"
  | "DECIMALS_UNVERIFIED"
  | "BUY_ROUTE_MISSING"
  | "SELL_ROUTE_MISSING"
  | "QUOTE_SUCCESS_RATE_LOW"
  | "ENTRY_EXIT_ROUTE_MISSING"
  | "ROUTER_DISTRIBUTION_UNKNOWN"
  | "QUOTE_LATENCY_INSUFFICIENT"
  | "BASIS_AGE_INSUFFICIENT"
  | "MARKET_SESSION_MAPPING_MISSING"
  | "SAMPLE_COUNT_LOW";

export type PairReadinessObservation = {
  side: PairDirection;
  sizeUsd: number;
  observedAtMs: number;
  pythFeedUpdateTimestampUs: number | null | undefined;
  quoteRequestMs: number | null | undefined;
  basisAgeMs: number | null | undefined;
  timeRegime: TimeRegime | null | undefined;
  qualityStatus: QuoteQualityStatus | null | undefined;
};

export type RouterDistribution = {
  router: string;
  count: number;
  pct: number;
};

export type PairReadinessQuoteStats = {
  side: PairDirection;
  sizeUsd: number;
  totalCount: number;
  okCount: number;
  routerDistribution: RouterDistribution[];
};

export type Percentiles = {
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export type PairReadinessCheck = {
  code: PairReadinessReasonCode;
  passed: boolean;
  detail: string;
};

export type PairReadinessRow = {
  pairId: string;
  side: PairDirection;
  sizeUsd: number;
  status: PairReadinessStatus;
  reasonCodes: PairReadinessReasonCode[];
  sampleCount: number;
  liveEligibleCount: number;
  quoteSuccessRate: number | null;
  oppositeSideLiveCount: number;
  routerDistribution: RouterDistribution[];
  quoteLatencyMs: Percentiles;
  basisAgeMs: Percentiles;
  checks: PairReadinessCheck[];
};

export type PairReadinessMatrix = {
  status: PairReadinessStatus;
  rows: PairReadinessRow[];
};

export type PairReadinessOptions = {
  minSampleCount: number;
  minQuoteSuccessRate: number;
};

const DEFAULT_READINESS_OPTIONS: PairReadinessOptions = {
  minSampleCount: 20,
  minQuoteSuccessRate: 0.8,
};

export function buildPairReadinessMatrix(args: {
  pair: PairConfig;
  observations: readonly PairReadinessObservation[];
  quoteStats: readonly PairReadinessQuoteStats[];
  options?: Partial<PairReadinessOptions>;
}): PairReadinessMatrix {
  const options = { ...DEFAULT_READINESS_OPTIONS, ...args.options };
  const rows: PairReadinessRow[] = [];
  const pairObservations = args.observations;
  const validPythFeed =
    args.pair.base.pythSymbol.length > 0 &&
    Number.isInteger(args.pair.base.pythLazerId) &&
    args.pair.base.pythLazerId >= 0;
  const feedUpdatesReceived = pairObservations.some(
    (row) => (row.pythFeedUpdateTimestampUs ?? 0) > 0,
  );
  const decimalsOk = decimalsVerified(args.pair);

  for (const side of args.pair.directions) {
    for (const sizeUsd of args.pair.sizesUsd) {
      const observations = pairObservations.filter(
        (row) => row.side === side && row.sizeUsd === sizeUsd,
      );
      const liveRows = observations.filter((row) => row.qualityStatus === "LIVE_ELIGIBLE");
      const oppositeSide: PairDirection =
        side === "buy_tokenized" ? "sell_tokenized" : "buy_tokenized";
      const oppositeLiveRows = pairObservations.filter(
        (row) =>
          row.side === oppositeSide &&
          row.sizeUsd === sizeUsd &&
          row.qualityStatus === "LIVE_ELIGIBLE",
      );
      const stats = quoteStatsFor(args.quoteStats, side, sizeUsd);
      const buyStats = quoteStatsFor(args.quoteStats, "buy_tokenized", sizeUsd);
      const sellStats = quoteStatsFor(args.quoteStats, "sell_tokenized", sizeUsd);
      const quoteSuccessRate =
        stats.totalCount === 0 ? null : stats.okCount / stats.totalCount;
      const hasKnownRouter = stats.routerDistribution.some(
        (row) => row.router !== "UNKNOWN" && row.count > 0,
      );
      const hasMarketSession = observations.some((row) => row.timeRegime != null);
      const quoteLatencyMs = percentiles(
        observations
          .map((row) => row.quoteRequestMs)
          .filter((value): value is number => value != null && Number.isFinite(value)),
      );
      const basisAgeMs = percentiles(
        observations
          .map((row) => row.basisAgeMs)
          .filter((value): value is number => value != null && Number.isFinite(value)),
      );

      const checks: PairReadinessCheck[] = [
        check("PYTH_FEED_MISSING", validPythFeed, "valid Pyth feed configured"),
        check("NO_FEED_UPDATES", feedUpdatesReceived, "Pyth feed updates observed"),
        check("DECIMALS_UNVERIFIED", decimalsOk, "SPL/USDC decimals are verified"),
        check("BUY_ROUTE_MISSING", buyStats.okCount > 0, "$250/$1000 buy route exists"),
        check("SELL_ROUTE_MISSING", sellStats.okCount > 0, "$250/$1000 sell route exists"),
        check(
          "QUOTE_SUCCESS_RATE_LOW",
          quoteSuccessRate != null && quoteSuccessRate >= options.minQuoteSuccessRate,
          `quote success rate ${quoteSuccessRate == null ? "missing" : pct(quoteSuccessRate)}`,
        ),
        check(
          "ENTRY_EXIT_ROUTE_MISSING",
          buyStats.okCount > 0 && sellStats.okCount > 0 && oppositeLiveRows.length > 0,
          "entry and opposite-side exit routes both exist",
        ),
        check("ROUTER_DISTRIBUTION_UNKNOWN", hasKnownRouter, "router distribution known"),
        check("QUOTE_LATENCY_INSUFFICIENT", quoteLatencyMs.p50 != null, "quote latency samples exist"),
        check("BASIS_AGE_INSUFFICIENT", basisAgeMs.p50 != null, "basis age samples exist"),
        check("MARKET_SESSION_MAPPING_MISSING", hasMarketSession, "market session mapping exists"),
        check(
          "SAMPLE_COUNT_LOW",
          liveRows.length >= options.minSampleCount,
          `${liveRows.length}/${options.minSampleCount} live-eligible samples`,
        ),
      ];
      const reasonCodes = checks
        .filter((row) => !row.passed)
        .map((row) => row.code);
      const critical = reasonCodes.some((code) =>
        code === "PYTH_FEED_MISSING" ||
        code === "NO_FEED_UPDATES" ||
        code === "DECIMALS_UNVERIFIED" ||
        code === (side === "buy_tokenized" ? "BUY_ROUTE_MISSING" : "SELL_ROUTE_MISSING")
      );
      const status: PairReadinessStatus =
        critical ? "NOT_READY" : reasonCodes.length > 0 ? "RESEARCH_ONLY" : "READY";

      rows.push({
        pairId: args.pair.id,
        side,
        sizeUsd,
        status,
        reasonCodes,
        sampleCount: observations.length,
        liveEligibleCount: liveRows.length,
        quoteSuccessRate,
        oppositeSideLiveCount: oppositeLiveRows.length,
        routerDistribution: stats.routerDistribution,
        quoteLatencyMs,
        basisAgeMs,
        checks,
      });
    }
  }

  const status: PairReadinessStatus =
    rows.some((row) => row.status === "NOT_READY") ? "NOT_READY"
    : rows.every((row) => row.status === "READY") ? "READY"
    : "RESEARCH_ONLY";
  return { status, rows };
}

export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, idx))]!;
}

function quoteStatsFor(
  rows: readonly PairReadinessQuoteStats[],
  side: PairDirection,
  sizeUsd: number,
): PairReadinessQuoteStats {
  return rows.find((row) => row.side === side && row.sizeUsd === sizeUsd) ?? {
    side,
    sizeUsd,
    totalCount: 0,
    okCount: 0,
    routerDistribution: [],
  };
}

function check(
  code: PairReadinessReasonCode,
  passed: boolean,
  detail: string,
): PairReadinessCheck {
  return { code, passed, detail };
}

function decimalsVerified(pair: PairConfig): boolean {
  return Number.isInteger(pair.tokenized.decimals) &&
    pair.tokenized.decimals >= 0 &&
    pair.tokenized.decimals <= 18 &&
    pair.quote.decimals === 6;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
