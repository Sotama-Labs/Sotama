/** Wire-format types for the bot HTTP read API. Dates serialize as ISO 8601
 *  strings — Date is intentionally absent from these types. The bot
 *  produces these shapes; the Vercel dashboard consumes them via fetch. */

import type { PairConfig } from "./pair-config";

export type BestSideDto = {
  /** tokenPrice / basePrice. For buy: <1 favorable. For sell: >1 favorable. */
  ratio: number;
  sizeUsd: number;
  netBps: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  observedAt: string;
  quality?: "live" | "warm" | "stale" | "invalid";
  pythFreshnessLagMs?: number | null;
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
  quality: "live" | "warm" | "stale" | "invalid";
  pythFreshnessLagMs: number | null;
  quoteRequestMs: number | null;
  basisAgeMs: number | null;
};

export type BasisSeriesPointDto = {
  side: "buy_tokenized" | "sell_tokenized";
  sizeUsd: number;
  netBps: number;
  tokenPriceUsd: number;
  quality: "live" | "warm" | "stale" | "invalid";
  observedAt: string;
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
  signalHistory: SignalHistoryDto[];
  profitability: import("./profitability").ProfitabilitySummary;
};
