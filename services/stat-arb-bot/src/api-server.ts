/** Public read-only HTTP API for the bot.
 *
 *  The Vercel dashboard fetches these endpoints over HTTPS; the bot is the
 *  only process with private-network access to Fly Postgres. Endpoints are
 *  read-only. Treat this as internal strategy data; production access should
 *  be restricted by the dashboard and hosting layer before exposing detailed
 *  diagnostics outside the owner/admin context. */

import http from "node:http";
import {
  listAllPairs,
  getPair,
  latestBasisPerKey,
  latestHeartbeat,
  basisHistory,
  basisRegimeSummary,
  basisQualityDistribution,
  quoteStatsByPair,
  closedSignals,
  type BasisObservationRow,
  type TimeRegimeSummaryRow,
} from "@sotama/db";
import type {
  AssetClass,
  BasisSeriesPointDto,
  BestSideDto,
  BestSpreadDto,
  DashboardSnapshotDto,
  HealthResponseDto,
  HeartbeatDto,
  PairDetailDto,
  PairPanelDto,
  QuoteQualityDistributionDto,
  QuoteSurfaceRowDto,
  SignalHistoryDto,
  TimeRegime,
  TimeRegimeSummaryDto,
} from "@sotama/market-core";
import {
  buildPairReadinessMatrix,
  runTwoSizeBacktestV2,
  summarize,
} from "@sotama/market-core";

const LATEST_WITHIN_MS = 5 * 60_000;
const HISTORY_WINDOW_MS = 24 * 3600 * 1000;
const SIGNAL_WINDOW_MS = 7 * 24 * 3600 * 1000;
const BASIS_SERIES_LIMIT = 720;
const HEARTBEAT_STALE_MS = 30_000;

export type ApiServerOptions = {
  port: number;
  transactionCostBps?: number;
  /** Origin allow-list for CORS. `*` is permissive (V1 default). Set to
   *  the dashboard's origin in prod if we ever serve sensitive data. */
  corsOrigin?: string;
};

export function createApiServer(opts: ApiServerOptions): http.Server {
  const corsOrigin = opts.corsOrigin ?? "*";
  const transactionCostBps = opts.transactionCostBps ?? 0;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, corsOrigin, transactionCostBps).catch((e) => {
      try {
        sendJson(res, 500, { error: String(e?.message ?? e) });
      } catch {
        /* socket already closed */
      }
    });
  });
  server.listen(opts.port);
  return server;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  corsOrigin: string,
  transactionCostBps: number,
): Promise<void> {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/health") {
    return handleHealth(res);
  }
  if (path === "/api/dashboard") {
    return handleDashboard(res);
  }
  const pairMatch = path.match(/^\/api\/pairs\/([^/]+)$/);
  if (pairMatch) {
    return handlePairDetail(res, decodeURIComponent(pairMatch[1]!), transactionCostBps);
  }

  sendJson(res, 404, { error: "not found", path });
}

async function handleHealth(res: http.ServerResponse): Promise<void> {
  const hb = await latestHeartbeat();
  const ageMs = hb ? Date.now() - hb.observedAt.getTime() : null;
  const ok = ageMs != null && ageMs <= HEARTBEAT_STALE_MS;
  const body: HealthResponseDto = {
    ok,
    heartbeatAgeMs: ageMs,
    heartbeat: hb ? toHeartbeatDto(hb) : null,
  };
  sendJson(res, ok ? 200 : 503, body);
}

async function handleDashboard(res: http.ServerResponse): Promise<void> {
  const [pairs, basis, hb] = await Promise.all([
    listAllPairs(),
    latestBasisPerKey({ withinMs: LATEST_WITHIN_MS }),
    latestHeartbeat(),
  ]);

  const byPair = groupBasis(basis);
  const now = Date.now();
  const panels: PairPanelDto[] = pairs.map((pair) => buildPanel(pair, byPair, now));

  const body: DashboardSnapshotDto = {
    panels,
    heartbeat: hb ? toHeartbeatDto(hb) : null,
  };
  sendJson(res, 200, body);
}

async function handlePairDetail(
  res: http.ServerResponse,
  id: string,
  transactionCostBps: number,
): Promise<void> {
  const pair = await getPair(id);
  if (!pair) {
    sendJson(res, 404, { error: "pair not found", id });
    return;
  }

  const nowMs = Date.now();
  const sinceMs = nowMs - HISTORY_WINDOW_MS;
  const signalSinceMs = nowMs - SIGNAL_WINDOW_MS;
  const [latest, signals, regimeRows, qualityRows, quoteStats, ...historyArrays] = await Promise.all([
    latestBasisPerKey({ withinMs: LATEST_WITHIN_MS }),
    closedSignals({ pairId: id, sinceMs: signalSinceMs }),
    basisRegimeSummary({ pairId: id, sinceMs }),
    basisQualityDistribution({ pairId: id, sinceMs }),
    quoteStatsByPair({ pairId: id, sinceMs }),
    ...pair.sizesUsd.flatMap((size) =>
      pair.directions.map((side) =>
        basisHistory({ pairId: id, side, sizeUsd: size, sinceMs }),
      ),
    ),
  ]);

  const forPair = latest.filter((b) => b.pairId === id);
  const byPair = groupBasis(forPair);
  const panel = buildPanel(pair, byPair, Date.now());
  const historyRows = historyArrays
    .flat()
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const observationCount24h = historyRows.length;
  const liveEligibleSignals = signals.filter(
    (s) =>
      s.entryQualityStatus === "LIVE_ELIGIBLE" &&
      (s.exitQualityStatus ?? "LIVE_ELIGIBLE") === "LIVE_ELIGIBLE",
  );
  const pairReadiness = buildPairReadinessMatrix({
    pair,
    observations: historyRows.map(toReadinessObservation),
    quoteStats,
  });
  const twoSizeBacktest = runTwoSizeBacktestV2({
    observations: historyRows.map(toBacktestObservation),
    options: {
      minNetEdgeBps: pair.minNetEdgeBps,
      transactionCostBps,
      minLiveSamples: 20,
      researchOnly: pairReadiness.status !== "READY",
    },
  });

  const body: PairDetailDto = {
    pair,
    bestBuy: panel.bestBuy,
    bestSell: panel.bestSell,
    bestSpread: panel.bestSpread,
    quoteAgeMs: panel.quoteAgeMs,
    observationCount24h,
    quoteSurface: toQuoteSurface(forPair),
    basisSeries: downsample(historyRows, BASIS_SERIES_LIMIT).map(toBasisSeriesPoint),
    qualityDistribution: toQualityDistribution(qualityRows),
    timeRegimeSummary: toTimeRegimeSummary(pair.base.assetClass, regimeRows),
    pairReadiness,
    twoSizeBacktest,
    signalHistory: signals.slice(-50).map(toSignalHistory),
    profitability: summarize(
      liveEligibleSignals.map((s) => ({
        entryAt: s.entryAt.getTime(),
        exitAt: s.exitAt.getTime(),
        pnlUsd: s.pnlUsd,
        edgeBps: s.entryEdgeBps,
      })),
      nowMs,
    ),
  };
  sendJson(res, 200, body);
}

// ─── helpers ───────────────────────────────────────────────────────

type PairBuckets = {
  buyBySize: Map<number, BasisObservationRow>;
  sellBySize: Map<number, BasisObservationRow>;
};

function groupBasis(basis: BasisObservationRow[]): Map<string, PairBuckets> {
  const out = new Map<string, PairBuckets>();
  for (const b of basis) {
    const cur =
      out.get(b.pairId) ??
      ({
        buyBySize: new Map<number, BasisObservationRow>(),
        sellBySize: new Map<number, BasisObservationRow>(),
      } as PairBuckets);
    if (b.side === "buy_tokenized") cur.buyBySize.set(b.sizeUsd, b);
    else cur.sellBySize.set(b.sizeUsd, b);
    out.set(b.pairId, cur);
  }
  return out;
}

function buildPanel(
  pair: { id: string; directions: readonly string[]; sizesUsd: readonly number[] } & Record<string, unknown>,
  byPair: Map<string, PairBuckets>,
  nowMs: number,
): PairPanelDto {
  const buckets =
    byPair.get(pair.id) ??
    ({
      buyBySize: new Map<number, BasisObservationRow>(),
      sellBySize: new Map<number, BasisObservationRow>(),
    } as PairBuckets);

  const bestBuy = pickBest(buckets.buyBySize.values(), "buy");
  const bestSell = pickBest(buckets.sellBySize.values(), "sell");
  const bestSpread = pickBestSpread(buckets.buyBySize, buckets.sellBySize);

  const ages: number[] = [];
  if (bestBuy) ages.push(nowMs - new Date(bestBuy.observedAt).getTime());
  if (bestSell) ages.push(nowMs - new Date(bestSell.observedAt).getTime());
  const quoteAgeMs = ages.length === 0 ? null : Math.min(...ages);

  return {
    pair: pair as unknown as PairPanelDto["pair"],
    bestBuy,
    bestSell,
    bestSpread,
    quoteAgeMs,
  };
}

function pickBest(
  iter: Iterable<BasisObservationRow>,
  kind: "buy" | "sell",
): BestSideDto | null {
  let best: BestSideDto | null = null;
  for (const b of iter) {
    if (b.basePriceUsd <= 0) continue;
    const ratio = b.tokenPriceUsd / b.basePriceUsd;
    if (!best) {
      best = toBestSide(b, ratio);
      continue;
    }
    const better = kind === "buy" ? ratio < best.ratio : ratio > best.ratio;
    if (better) best = toBestSide(b, ratio);
  }
  return best;
}

function toBestSide(b: BasisObservationRow, ratio: number): BestSideDto {
  return {
    ratio,
    sizeUsd: b.sizeUsd,
    netBps: b.netBps,
    basePriceUsd: b.basePriceUsd,
    tokenPriceUsd: b.tokenPriceUsd,
    observedAt: b.observedAt.toISOString(),
    timeRegime: b.timeRegime ?? null,
    quality: b.quality,
    qualityStatus: b.qualityStatus,
    qualityReason: b.qualityReason,
    pythFreshnessLagMs: b.pythFreshnessLagMs,
    pythConfidenceBps: b.pythConfidenceBps,
    basisAgeMs: b.basisAgeMs,
  };
}

function pickBestSpread(
  buyBySize: Map<number, BasisObservationRow>,
  sellBySize: Map<number, BasisObservationRow>,
): BestSpreadDto | null {
  let best: BestSpreadDto | null = null;
  for (const [size, buyRow] of buyBySize) {
    const sellRow = sellBySize.get(size);
    if (!sellRow) continue;
    const mid = (buyRow.tokenPriceUsd + sellRow.tokenPriceUsd) / 2;
    if (mid <= 0) continue;
    const spreadBps =
      ((buyRow.tokenPriceUsd - sellRow.tokenPriceUsd) / mid) * 10000;
    const candidate: BestSpreadDto = {
      spreadBps,
      sizeUsd: size,
      buyTokenPriceUsd: buyRow.tokenPriceUsd,
      sellTokenPriceUsd: sellRow.tokenPriceUsd,
      observedAt: new Date(
        Math.max(buyRow.observedAt.getTime(), sellRow.observedAt.getTime()),
      ).toISOString(),
    };
    if (!best || Math.abs(spreadBps) < Math.abs(best.spreadBps)) best = candidate;
  }
  return best;
}

function toHeartbeatDto(hb: {
  observedAt: Date;
  activePairCount: number;
  currentRps: number;
  http429Count1m: number;
  errorCount1m: number;
  streamLagMs: number | null;
  quoteLagMs: number | null;
  activeLazerEndpointCount?: number | null;
  lazerEndpointHealth?: unknown | null;
  invalidFeedCount1m?: number;
}): HeartbeatDto {
  return {
    observedAt: hb.observedAt.toISOString(),
    activePairs: hb.activePairCount,
    currentRps: hb.currentRps,
    http429Count1m: hb.http429Count1m,
    errorCount1m: hb.errorCount1m,
    streamLagMs: hb.streamLagMs,
    quoteLagMs: hb.quoteLagMs,
    activeLazerEndpointCount: hb.activeLazerEndpointCount ?? null,
    lazerEndpointHealth: hb.lazerEndpointHealth ?? null,
    invalidFeedCount1m: hb.invalidFeedCount1m ?? 0,
  };
}

function toQuoteSurface(rows: BasisObservationRow[]): QuoteSurfaceRowDto[] {
  return [...rows]
    .sort((a, b) => a.sizeUsd - b.sizeUsd || a.side.localeCompare(b.side))
    .map((b) => ({
      side: b.side,
      sizeUsd: b.sizeUsd,
      basePriceUsd: b.basePriceUsd,
      tokenPriceUsd: b.tokenPriceUsd,
      grossBps: b.grossBps,
      netBps: b.netBps,
      observedAt: b.observedAt.toISOString(),
      timeRegime: b.timeRegime ?? null,
      quality: b.quality ?? "live",
      qualityStatus: b.qualityStatus ?? "LIVE_ELIGIBLE",
      qualityReason: b.qualityReason ?? "legacy row before quality gate",
      pythFreshnessLagMs: b.pythFreshnessLagMs ?? null,
      pythConfidenceBps: b.pythConfidenceBps ?? null,
      quoteRequestMs: b.quoteRequestMs ?? null,
      basisAgeMs: b.basisAgeMs ?? null,
    }));
}

function toBasisSeriesPoint(b: BasisObservationRow): BasisSeriesPointDto {
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    netBps: b.netBps,
    tokenPriceUsd: b.tokenPriceUsd,
    quality: b.quality ?? "live",
    qualityStatus: b.qualityStatus ?? "LIVE_ELIGIBLE",
    timeRegime: b.timeRegime ?? null,
    observedAt: b.observedAt.toISOString(),
  };
}

function toReadinessObservation(b: BasisObservationRow) {
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    observedAtMs: b.observedAt.getTime(),
    pythFeedUpdateTimestampUs: b.pythFeedUpdateTimestampUs,
    quoteRequestMs: b.quoteRequestMs,
    basisAgeMs: b.basisAgeMs,
    timeRegime: b.timeRegime,
    qualityStatus: b.qualityStatus,
  };
}

function toBacktestObservation(b: BasisObservationRow) {
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    observedAtMs: b.observedAt.getTime(),
    basePriceUsd: b.basePriceUsd,
    tokenPriceUsd: b.tokenPriceUsd,
    netBps: b.netBps,
    qualityStatus: b.qualityStatus,
  };
}

function toQualityDistribution(
  rows: Awaited<ReturnType<typeof basisQualityDistribution>>,
): QuoteQualityDistributionDto[] {
  return rows.map((row) => ({
    qualityStatus: row.qualityStatus,
    observationCount: row.observationCount,
    observationPct: row.observationPct,
  }));
}

function toTimeRegimeSummary(
  assetClass: AssetClass,
  rows: TimeRegimeSummaryRow[],
): TimeRegimeSummaryDto[] {
  const byRegime = new Map<TimeRegime, TimeRegimeSummaryRow>(
    rows.map((row) => [row.timeRegime, row]),
  );
  return regimesForAssetClass(assetClass).map((timeRegime) => {
    const row = byRegime.get(timeRegime);
    if (!row) {
      return {
        timeRegime,
        observationCount: 0,
        liveCount: 0,
        livePct: 0,
        avgGrossBps: null,
        avgNetBps: null,
        maxNetBps: null,
        minNetBps: null,
        buyCount: 0,
        sellCount: 0,
        avgQuoteRequestMs: null,
        avgPythFreshnessLagMs: null,
        avgBasisAgeMs: null,
      };
    }
    return row;
  });
}

function regimesForAssetClass(assetClass: AssetClass): readonly TimeRegime[] {
  switch (assetClass) {
    case "Equity":
      return [
        "US_EQUITY_REGULAR",
        "US_EQUITY_PREMARKET",
        "US_EQUITY_POSTMARKET",
        "US_EQUITY_OVERNIGHT",
        "US_EQUITY_WEEKEND",
      ];
    case "Metal":
      return ["METAL_ACTIVE", "METAL_MAINTENANCE", "METAL_WEEKEND"];
    case "Crypto":
      return ["CRYPTO_NORMAL", "CRYPTO_HIGH_VOL"];
    default:
      return [];
  }
}

function toSignalHistory(s: Awaited<ReturnType<typeof closedSignals>>[number]): SignalHistoryDto {
  return {
    id: s.id.toString(),
    sizeUsd: s.sizeUsd,
    entryAt: s.entryAt.toISOString(),
    exitAt: s.exitAt.toISOString(),
    entryEdgeBps: s.entryEdgeBps,
    exitEdgeBps: s.exitEdgeBps,
    pnlUsd: s.pnlUsd,
    outcome: s.outcome,
    exitReason: s.exitReason,
    entryQualityStatus: s.entryQualityStatus,
    exitQualityStatus: s.exitQualityStatus,
  };
}

function downsample<T>(rows: T[], limit: number): T[] {
  if (rows.length <= limit) return rows;
  const step = rows.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    out.push(rows[Math.floor(i * step)]!);
  }
  return out;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
