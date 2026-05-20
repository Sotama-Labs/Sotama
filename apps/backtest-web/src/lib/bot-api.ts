/** Typed HTTPS client for the stat-arb bot's read API.
 *
 *  V1: server-side fetch from Next.js RSC. The dashboard's pages run on
 *  Vercel; the bot lives on Fly and is the only process with direct DB
 *  access. This module is the *only* place that knows the bot URL — pages
 *  consume the typed helpers. */

import type {
  DashboardSnapshotDto,
  HealthResponseDto,
  PairDetailDto,
} from "@sotama/market-core";

/** Cold-miss budgets for the bot's HTTPS API. Steady-state hits are <100 ms
 *  (Vercel-side cache + bot in-memory cache). The longer pair-detail budget
 *  handles the rare cold compute when the 5-minute pair-detail cache
 *  expires. */
const REQUEST_TIMEOUT_MS = 10_000;
const PAIR_DETAIL_TIMEOUT_MS = 25_000;

/** Vercel `next.revalidate` windows (seconds). Operator endorsed slower
 *  polling, so these are intentionally generous for research payloads. Health
 *  is deliberately no-store because the badge compares timestamps at render
 *  time; serving a cached heartbeat makes a live bot look stale. */
const DASHBOARD_REVALIDATE_S = 30;
const PAIR_DETAIL_REVALIDATE_S = 60;

function botBaseUrl(): string {
  const url = process.env.BOT_API_URL;
  if (!url) throw new Error("BOT_API_URL is not set");
  return url.replace(/\/+$/, "");
}

async function getJson<T>(
  path: string,
  options: { revalidateS: number; tags?: string[] },
): Promise<T> {
  const url = `${botBaseUrl()}${path}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // Next.js caches at the data layer; multiple browser hits within
    // `revalidate` seconds hit the cache, not the bot. Combined with the
    // bot's own in-memory TTL cache this gives a 2-layer hit pipeline.
    next: { revalidate: options.revalidateS, tags: options.tags },
  });
  if (!res.ok && res.status !== 503) {
    throw new Error(`bot ${path} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchDashboard(): Promise<DashboardSnapshotDto> {
  return getJson<DashboardSnapshotDto>("/api/dashboard", {
    revalidateS: DASHBOARD_REVALIDATE_S,
    tags: ["bot-dashboard"],
  });
}

export async function fetchHealth(): Promise<HealthResponseDto> {
  const res = await fetch(`${botBaseUrl()}/api/health`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 503) {
    throw new Error(`bot /api/health returned HTTP ${res.status}`);
  }
  return (await res.json()) as HealthResponseDto;
}

export async function fetchPairDetail(id: string): Promise<PairDetailDto | null> {
  const url = `${botBaseUrl()}/api/pairs/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(PAIR_DETAIL_TIMEOUT_MS),
    next: {
      revalidate: PAIR_DETAIL_REVALIDATE_S,
      tags: [`bot-pair:${id}`],
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`bot pair ${id} returned HTTP ${res.status}`);
  return (await res.json()) as PairDetailDto;
}
