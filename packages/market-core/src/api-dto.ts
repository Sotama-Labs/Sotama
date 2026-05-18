/** Wire-format types for the bot HTTP read API. Dates serialize as ISO 8601
 *  strings — Date is intentionally absent from these types. The bot produces
 *  these shapes; the Vercel dashboard consumes them via fetch. */

import type { CostInputsBps, CostScenario, CostWaterfall } from "./cost-waterfall";
import type { DisplayBasisInterpretation } from "./display-orientation";
import type { HoldHorizonReplayRow } from "./hold-horizon";
import type { PairClass, ReferenceStatus } from "./pair-class";
import type { PairConfig, PairDirection } from "./pair-config";
import type { PairReadinessMatrix } from "./pair-readiness";
import type {
  PairResearchVerdict,
  TokenValidationSnapshot,
} from "./research-verdict";
import type { RouteStabilitySummary } from "./route-stability";
import type { QuoteQualityStatus } from "./quote-quality";
import type { PairStatSummary } from "./stat-summary";
import type { TimeRegime } from "./time-regime";
import type { TwoSizeBacktestV2Result } from "./two-size-backtest";

// ─── primitive opportunity shapes ──────────────────────────────────

export type BestSideDto = {
  /** tokenPrice / basePrice. For buy: <1 favorable. For sell: >1 favorable. */
  ratio: number;
  sizeUsd: number;
  netBps: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  observedAt: string;
  side: PairDirection;
  timeRegime?: TimeRegime | null;
  quality?: "live" | "warm" | "stale" | "invalid";
  qualityStatus?: QuoteQualityStatus;
  qualityReason?: string;
  pythFreshnessLagMs?: number | null;
  pythConfidenceBps?: number | null;
  basisAgeMs?: number | null;
  displayBasisBps?: number | null;
  displayBasisInterpretation?: DisplayBasisInterpretation | null;
};

export type BestSpreadDto = {
  /** (buyTokenPrice - sellTokenPrice) / mid * 10000. Positive = round-trip cost. */
  spreadBps: number;
  sizeUsd: number;
  buyTokenPriceUsd: number;
  sellTokenPriceUsd: number;
  observedAt: string;
  /** Synchronized buy/sell rows only — null when no synchronized pair found. */
  synchronized: boolean;
  maxAgeGapMs: number | null;
};

export type CurrentOpportunityDto = {
  /** Both legs are LIVE_ELIGIBLE and within `maxAgeGapMs`. */
  hasLiveOpportunity: boolean;
  bestBuy: BestSideDto | null;
  bestSell: BestSideDto | null;
  roundTripSpread: BestSpreadDto | null;
  /** Quote age of the freshest live row used here. */
  quoteAgeMs: number | null;
  notExecutableReason: string | null;
};

// ─── heartbeat + dashboard envelope ────────────────────────────────

export type SchedulerTelemetryDto = {
  scheduledQuotes1m: number;
  admittedQuotes1m: number;
  droppedDueToRps1m: number;
  droppedDueToStalePyth1m: number;
  droppedDueToMarketSession1m: number;
  perPair: Array<{
    pairId: string;
    scheduled: number;
    admitted: number;
    droppedDueToRps: number;
    droppedDueToStalePyth: number;
    droppedDueToMarketSession: number;
  }>;
};

export type HeartbeatDto = {
  observedAt: string;
  activePairs: number;
  currentRps: number;
  http429Count1m: number;
  errorCount1m: number;
  streamLagMs: number | null;
  quoteLagMs: number | null;
  activeLazerEndpointCount?: number | null;
  lazerEndpointHealth?: unknown | null;
  invalidFeedCount1m?: number;
  schedulerTelemetry?: SchedulerTelemetryDto | null;
};

export type PairPanelDto = {
  pair: PairConfig;
  pairClass: PairClass;
  displayLabel: string;
  referenceStatus: ReferenceStatus;
  /** Quality-safe summary — only LIVE_ELIGIBLE rows. */
  currentOpportunity: CurrentOpportunityDto;
  /** Diagnostic rows (any quality) used when no live opportunity exists. */
  bestDiagnosticBuy: BestSideDto | null;
  bestDiagnosticSell: BestSideDto | null;
  verdict: PairResearchVerdict;
  liveSampleCount24h: number;
  primaryBlocker: string | null;

  /** ---- legacy fields kept for transitional dashboards ---- */
  bestBuy: BestSideDto | null;
  bestSell: BestSideDto | null;
  bestSpread: BestSpreadDto | null;
  quoteAgeMs: number | null;
};

export type DashboardSnapshotDto = {
  panels: PairPanelDto[];
  heartbeat: HeartbeatDto | null;
  schedulerTelemetry: SchedulerTelemetryDto | null;
};

export type HealthResponseDto = {
  ok: boolean;
  heartbeatAgeMs: number | null;
  heartbeat: HeartbeatDto | null;
};

// ─── pair-detail data ──────────────────────────────────────────────

export type QuoteSurfaceRowDto = {
  side: PairDirection;
  sizeUsd: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  grossBps: number;
  netBps: number;
  observedAt: string;
  timeRegime: TimeRegime | null;
  quality: "live" | "warm" | "stale" | "invalid";
  qualityStatus: QuoteQualityStatus;
  qualityReason: string;
  pythFreshnessLagMs: number | null;
  pythConfidenceBps: number | null;
  quoteRequestMs: number | null;
  basisAgeMs: number | null;
  displayBasisBps: number | null;
  displayBasisInterpretation: DisplayBasisInterpretation | null;
};

export type BasisSeriesPointDto = {
  side: PairDirection;
  sizeUsd: number;
  netBps: number;
  tokenPriceUsd: number;
  quality: "live" | "warm" | "stale" | "invalid";
  qualityStatus: QuoteQualityStatus;
  timeRegime: TimeRegime | null;
  observedAt: string;
  displayBasisBps: number | null;
};

export type QuoteQualityDistributionDto = {
  qualityStatus: QuoteQualityStatus;
  observationCount: number;
  observationPct: number;
};

export type TimeRegimeSummaryDto = {
  timeRegime: TimeRegime;
  observationCount: number;
  liveCount: number;
  livePct: number;
  avgGrossBps: number | null;
  avgNetBps: number | null;
  maxNetBps: number | null;
  minNetBps: number | null;
  buyCount: number;
  sellCount: number;
  avgQuoteRequestMs: number | null;
  avgPythFreshnessLagMs: number | null;
  avgBasisAgeMs: number | null;
};

export type SignalHistoryDto = {
  id: string;
  sizeUsd: number;
  entryAt: string;
  exitAt: string;
  entryEdgeBps: number;
  exitEdgeBps: number;
  pnlUsd: number;
  outcome: string;
  exitReason: string | null;
  entryQualityStatus: QuoteQualityStatus;
  exitQualityStatus: QuoteQualityStatus | null;
};

export type CostScenarioDto = {
  name: CostScenario["name"];
  label: string;
  description: string;
  waterfall: CostWaterfall;
};

export type PairDetailDto = {
  pair: PairConfig;
  pairClass: PairClass;
  displayLabel: string;
  referenceStatus: ReferenceStatus;
  verdict: PairResearchVerdict;
  currentOpportunity: CurrentOpportunityDto;
  bestDiagnosticBuy: BestSideDto | null;
  bestDiagnosticSell: BestSideDto | null;

  observationCount24h: number;
  liveSampleCount24h: number;

  quoteSurface: QuoteSurfaceRowDto[];
  basisSeries: BasisSeriesPointDto[];
  qualityDistribution: QuoteQualityDistributionDto[];
  timeRegimeSummary: TimeRegimeSummaryDto[];

  pairReadiness: PairReadinessMatrix;
  twoSizeBacktest: TwoSizeBacktestV2Result;
  holdHorizonReplay: HoldHorizonReplayRow[];

  statSummary: PairStatSummary[];
  routeStability: RouteStabilitySummary;
  tokenValidation: TokenValidationSnapshot;
  costWaterfall: CostWaterfall;
  costScenarios: CostScenarioDto[];
  costInputsBps: CostInputsBps;

  signalHistory: SignalHistoryDto[];
  profitability: import("./profitability").ProfitabilitySummary;

  /** ---- legacy fields kept for transitional dashboards ---- */
  bestBuy: BestSideDto | null;
  bestSell: BestSideDto | null;
  bestSpread: BestSpreadDto | null;
  quoteAgeMs: number | null;
};
