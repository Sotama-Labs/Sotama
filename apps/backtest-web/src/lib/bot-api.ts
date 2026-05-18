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

/** /api/health + /api/dashboard return cached snapshots quickly (<1s
 *  in the steady state). /api/pairs/:id runs hold-horizon replay + stat
 *  summary + route stability when its cache is cold, which can take
 *  10–15s on a 512MB Fly machine. */
const REQUEST_TIMEOUT_MS = 6000;
const PAIR_DETAIL_TIMEOUT_MS = 25000;

function botBaseUrl(): string {
  const url = process.env.BOT_API_URL;
  if (!url) throw new Error("BOT_API_URL is not set");
  return url.replace(/\/+$/, "");
}

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${botBaseUrl()}${path}`;
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // Next.js caches fetches by default; opt out so the dashboard reflects
    // fresh quote state on every render.
    cache: "no-store",
  });
  if (!res.ok && res.status !== 503) {
    throw new Error(`bot ${path} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchDashboard(): Promise<DashboardSnapshotDto> {
  return getJson<DashboardSnapshotDto>("/api/dashboard");
}

export async function fetchHealth(): Promise<HealthResponseDto> {
  return getJson<HealthResponseDto>("/api/health");
}

export async function fetchPairDetail(id: string): Promise<PairDetailDto | null> {
  const url = `${botBaseUrl()}/api/pairs/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(PAIR_DETAIL_TIMEOUT_MS),
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`bot pair ${id} returned HTTP ${res.status}`);
  return (await res.json()) as PairDetailDto;
}
