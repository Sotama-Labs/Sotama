/** Public read-only HTTP API for the bot.
 *
 *  The Vercel dashboard fetches these endpoints over HTTPS; the bot is the
 *  only process with private-network access to Fly Postgres. Endpoints are
 *  unauthenticated — the data (pair configs, latest basis, paper signals)
 *  is non-sensitive. Admin write endpoints will be added later behind
 *  ADMIN_PASSWORD when the dashboard's pair-builder lands. */

import http from "node:http";
import {
  listAllPairs,
  getPair,
  latestBasisPerKey,
  latestHeartbeat,
  basisHistory,
  type BasisObservationRow,
} from "@sotama/db";
import type {
  BestSideDto,
  BestSpreadDto,
  DashboardSnapshotDto,
  HealthResponseDto,
  HeartbeatDto,
  PairDetailDto,
  PairPanelDto,
} from "@sotama/market-core";

const LATEST_WITHIN_MS = 5 * 60_000;
const HISTORY_WINDOW_MS = 24 * 3600 * 1000;
const HEARTBEAT_STALE_MS = 30_000;

export type ApiServerOptions = {
  port: number;
  /** Origin allow-list for CORS. `*` is permissive (V1 default). Set to
   *  the dashboard's origin in prod if we ever serve sensitive data. */
  corsOrigin?: string;
};

export function createApiServer(opts: ApiServerOptions): http.Server {
  const corsOrigin = opts.corsOrigin ?? "*";

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, corsOrigin).catch((e) => {
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
    return handlePairDetail(res, decodeURIComponent(pairMatch[1]!));
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
): Promise<void> {
  const pair = await getPair(id);
  if (!pair) {
    sendJson(res, 404, { error: "pair not found", id });
    return;
  }

  const sinceMs = Date.now() - HISTORY_WINDOW_MS;
  const [latest, ...historyArrays] = await Promise.all([
    latestBasisPerKey({ withinMs: LATEST_WITHIN_MS }),
    ...pair.sizesUsd.flatMap((size) =>
      pair.directions.map((side) =>
        basisHistory({ pairId: id, side, sizeUsd: size, sinceMs }),
      ),
    ),
  ]);

  const forPair = latest.filter((b) => b.pairId === id);
  const byPair = groupBasis(forPair);
  const panel = buildPanel(pair, byPair, Date.now());
  const observationCount24h = historyArrays.reduce((acc, rows) => acc + rows.length, 0);

  const body: PairDetailDto = {
    pair,
    bestBuy: panel.bestBuy,
    bestSell: panel.bestSell,
    bestSpread: panel.bestSpread,
    quoteAgeMs: panel.quoteAgeMs,
    observationCount24h,
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
}): HeartbeatDto {
  return {
    observedAt: hb.observedAt.toISOString(),
    activePairs: hb.activePairCount,
    currentRps: hb.currentRps,
    http429Count1m: hb.http429Count1m,
    errorCount1m: hb.errorCount1m,
    streamLagMs: hb.streamLagMs,
    quoteLagMs: hb.quoteLagMs,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
