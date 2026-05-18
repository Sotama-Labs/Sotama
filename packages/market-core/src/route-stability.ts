/** Route-stability aggregation over recent Jupiter quote rows.
 *
 *  Live executable Solana edge is only meaningful when the maker/router stays
 *  put long enough for the exit leg to be reachable. This module turns a flat
 *  list of jupiter_quotes rows into per-pair stability evidence: router shares,
 *  switch frequency, success rate, latency / price-impact percentiles, expiry
 *  and slot-age summaries. The bot's API layer calls this from the pair-detail
 *  handler. */

import type { PairDirection } from "./pair-config";

export type RouteStabilityQuoteRow = {
  side: PairDirection;
  sizeUsd: number;
  receivedAtMs: number;
  router: string | null;
  status: "ok" | "rate_limited" | "error" | "stale";
  requestMs: number;
  priceImpactPct: number | null;
  expiresAtMs: number | null;
  contextSlot: number | null;
};

export type StabilityPercentiles = {
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export type RouterShare = {
  router: string;
  count: number;
  pct: number;
};

export type RouteStabilityRow = {
  side: PairDirection;
  sizeUsd: number;
  sampleCount: number;
  okCount: number;
  successRate: number | null;
  routerDistribution: RouterShare[];
  routerChangesPerHour: number | null;
  topRouterShare: number | null;
  routeStable: boolean;
  requestLatencyMs: StabilityPercentiles;
  priceImpactBps: StabilityPercentiles;
  quoteExpirySeconds: StabilityPercentiles;
  avgContextSlotAge: number | null;
};

export type RouteStabilitySummary = {
  windowMs: number;
  totalSampleCount: number;
  totalOkCount: number;
  overallSuccessRate: number | null;
  topRouter: RouterShare | null;
  routerChangesPerHour: number | null;
  routeStable: boolean;
  perSideSize: RouteStabilityRow[];
};

export type RouteStabilityOptions = {
  windowMs: number;
  /** Top-router share above which we tentatively call the route "stable". */
  stableRouterShare?: number;
  /** Max router switches per hour for the route to be considered stable. */
  stableMaxChangesPerHour?: number;
};

const DEFAULT_STABLE_ROUTER_SHARE = 0.6;
const DEFAULT_STABLE_MAX_CHANGES_PER_HOUR = 6;

export function buildRouteStability(args: {
  rows: readonly RouteStabilityQuoteRow[];
  options: RouteStabilityOptions;
}): RouteStabilitySummary {
  const stableShare = args.options.stableRouterShare ?? DEFAULT_STABLE_ROUTER_SHARE;
  const maxChangesPerHour =
    args.options.stableMaxChangesPerHour ?? DEFAULT_STABLE_MAX_CHANGES_PER_HOUR;
  const sortedRows = [...args.rows].sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  const grouped = groupBy(sortedRows, (row) => `${row.side}|${row.sizeUsd}`);

  const perSideSize: RouteStabilityRow[] = [];
  for (const [, rows] of grouped) {
    perSideSize.push(buildSideRow(rows, args.options.windowMs, stableShare, maxChangesPerHour));
  }
  perSideSize.sort(
    (a, b) => a.side.localeCompare(b.side) || a.sizeUsd - b.sizeUsd,
  );

  const totalSampleCount = sortedRows.length;
  const totalOkCount = sortedRows.filter((row) => row.status === "ok").length;
  const overallSuccessRate =
    totalSampleCount === 0 ? null : totalOkCount / totalSampleCount;
  const overallDistribution = routerDistribution(
    sortedRows.filter((row) => row.status === "ok"),
  );
  const topRouter = overallDistribution[0] ?? null;
  const overallChangesPerHour = routerChangesPerHour(
    sortedRows.filter((row) => row.status === "ok"),
    args.options.windowMs,
  );
  const routeStable =
    (topRouter?.pct ?? 0) >= stableShare &&
    (overallChangesPerHour ?? Infinity) <= maxChangesPerHour;

  return {
    windowMs: args.options.windowMs,
    totalSampleCount,
    totalOkCount,
    overallSuccessRate,
    topRouter,
    routerChangesPerHour: overallChangesPerHour,
    routeStable,
    perSideSize,
  };
}

function buildSideRow(
  rows: readonly RouteStabilityQuoteRow[],
  windowMs: number,
  stableShare: number,
  maxChangesPerHour: number,
): RouteStabilityRow {
  const okRows = rows.filter((row) => row.status === "ok");
  const distribution = routerDistribution(okRows);
  const top = distribution[0] ?? null;
  const changesPerHour = routerChangesPerHour(okRows, windowMs);
  const requestLatencyMs = percentiles(okRows.map((row) => row.requestMs));
  const priceImpactBps = percentiles(
    okRows
      .map((row) => (row.priceImpactPct == null ? null : Math.abs(row.priceImpactPct) * 100))
      .filter((v): v is number => v != null && Number.isFinite(v)),
  );
  const quoteExpirySeconds = percentiles(
    okRows
      .map((row) =>
        row.expiresAtMs == null ? null : Math.max(0, (row.expiresAtMs - row.receivedAtMs) / 1000),
      )
      .filter((v): v is number => v != null && Number.isFinite(v)),
  );
  const slots = okRows.map((row) => row.contextSlot).filter((v): v is number => v != null);
  const avgContextSlotAge = slots.length === 0 ? null : mean(slots);
  return {
    side: rows[0]!.side,
    sizeUsd: rows[0]!.sizeUsd,
    sampleCount: rows.length,
    okCount: okRows.length,
    successRate: rows.length === 0 ? null : okRows.length / rows.length,
    routerDistribution: distribution,
    routerChangesPerHour: changesPerHour,
    topRouterShare: top?.pct ?? null,
    routeStable:
      (top?.pct ?? 0) >= stableShare && (changesPerHour ?? Infinity) <= maxChangesPerHour,
    requestLatencyMs,
    priceImpactBps,
    quoteExpirySeconds,
    avgContextSlotAge,
  };
}

function routerDistribution(rows: readonly RouteStabilityQuoteRow[]): RouterShare[] {
  if (rows.length === 0) return [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = row.router ?? "UNKNOWN";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = rows.length;
  return [...counts.entries()]
    .map(([router, count]) => ({ router, count, pct: count / total }))
    .sort((a, b) => b.count - a.count || a.router.localeCompare(b.router));
}

function routerChangesPerHour(
  rows: readonly RouteStabilityQuoteRow[],
  windowMs: number,
): number | null {
  if (rows.length < 2 || windowMs <= 0) return null;
  let changes = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if ((rows[i - 1]!.router ?? null) !== (rows[i]!.router ?? null)) {
      changes += 1;
    }
  }
  const hours = windowMs / 3_600_000;
  if (hours <= 0) return null;
  return changes / hours;
}

function percentiles(values: readonly number[]): StabilityPercentiles {
  if (values.length === 0) return { p50: null, p95: null, p99: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: quantile(sorted, 0.5),
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
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function mean(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function groupBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = keyOf(row);
    const list = out.get(k) ?? [];
    list.push(row);
    out.set(k, list);
  }
  return out;
}
