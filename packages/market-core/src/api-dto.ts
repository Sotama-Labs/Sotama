/** Wire-format types for the bot HTTP read API. Dates serialize as ISO 8601
 *  strings — Date is intentionally absent from these types. The bot
 *  produces these shapes; the Vercel dashboard consumes them via fetch. */

import type { PairConfig } from "./pair-config";
import type { QuoteQualityStatus } from "./quote-quality";
import type { TimeRegime } from "./time-regime";

export type BestSideDto = {
  /** tokenPrice / basePrice. For buy: <1 favorable. For sell: >1 favorable. */
  ratio: number;
  sizeUsd: number;
  netBps: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  observedAt: string;
  timeRegime?: TimeRegime | null;
  quality?: "live" | "warm" | "stale" | "invalid";
  qualityStatus?: QuoteQualityStatus;
  qualityReason?: string;
  pythFreshnessLagMs?: number | null;
  pythConfidenceBps?: number | null;
  basisAgeMs?: number | null;
};

export type BestSpreadDto = {
  /** (buyTokenPrice - sellTokenPrice) / mid * 10000. Positive = round-trip cost. */
  spreadBps: number;
  sizeUsd: number;
  buyTokenPriceUsd: number;
  sellTokenPriceUsd: number;
  observedAt: string;
};

export type PairPanelDto = {
  pair: PairConfig;
  bestBuy: BestSideDto | null;
  bestSell: BestSideDto | null;
  bestSpread: BestSpreadDto | null;
  quoteAgeMs: number | null;
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
};

export type DashboardSnapshotDto = {
  panels: PairPanelDto[];
  heartbeat: HeartbeatDto | null;
};

export type HealthResponseDto = {
  ok: boolean;
  heartbeatAgeMs: number | null;
  heartbeat: HeartbeatDto | null;
};

export type QuoteSurfaceRowDto = {
  side: "buy_tokenized" | "sell_tokenized";
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
};

export type BasisSeriesPointDto = {
  side: "buy_tokenized" | "sell_tokenized";
  sizeUsd: number;
  netBps: number;
  tokenPriceUsd: number;
  quality: "live" | "warm" | "stale" | "invalid";
  qualityStatus: QuoteQualityStatus;
  timeRegime: TimeRegime | null;
  observedAt: string;
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

export type PairDetailDto = {
  pair: PairConfig;
  bestBuy: BestSideDto | null;
  bestSell: BestSideDto | null;
  bestSpread: BestSpreadDto | null;
  quoteAgeMs: number | null;
  observationCount24h: number;
  quoteSurface: QuoteSurfaceRowDto[];
  basisSeries: BasisSeriesPointDto[];
  qualityDistribution: QuoteQualityDistributionDto[];
  timeRegimeSummary: TimeRegimeSummaryDto[];
  signalHistory: SignalHistoryDto[];
  profitability: import("./profitability").ProfitabilitySummary;
};
