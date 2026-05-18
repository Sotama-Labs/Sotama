import { listAllPairs, latestBasisPerKey, latestHeartbeat } from "@sotama/db";
import type { PairConfig, PairDirection } from "@sotama/market-core";

export type PairPanel = {
  pair: PairConfig;
  bestBuyNetBps: number | null;
  bestSellNetBps: number | null;
  bestBuySizeUsd: number | null;
  bestSellSizeUsd: number | null;
  quoteAgeMs: number | null;
};

export type DashboardSnapshot = {
  panels: PairPanel[];
  heartbeat: {
    observedAt: string | null;
    activePairs: number;
    currentRps: number;
    http429Count1m: number;
    streamLagMs: number | null;
    quoteLagMs: number | null;
  } | null;
};

export async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  const [pairs, basis, hb] = await Promise.all([
    listAllPairs(),
    latestBasisPerKey({ withinMs: 5 * 60_000 }),
    latestHeartbeat(),
  ]);

  const bestByPair = new Map<
    string,
    { buy: { bps: number; size: number; at: Date } | null; sell: { bps: number; size: number; at: Date } | null }
  >();
  for (const b of basis) {
    const cur = bestByPair.get(b.pairId) ?? { buy: null, sell: null };
    const side: PairDirection = b.side;
    const entry = { bps: b.netBps, size: b.sizeUsd, at: b.observedAt };
    if (side === "buy_tokenized") {
      if (!cur.buy || b.netBps > cur.buy.bps) cur.buy = entry;
    } else {
      if (!cur.sell || b.netBps > cur.sell.bps) cur.sell = entry;
    }
    bestByPair.set(b.pairId, cur);
  }

  const now = Date.now();
  const panels: PairPanel[] = pairs.map((pair) => {
    const best = bestByPair.get(pair.id) ?? { buy: null, sell: null };
    const ages: number[] = [];
    if (best.buy) ages.push(now - best.buy.at.getTime());
    if (best.sell) ages.push(now - best.sell.at.getTime());
    const quoteAgeMs = ages.length === 0 ? null : Math.min(...ages);
    return {
      pair,
      bestBuyNetBps: best.buy?.bps ?? null,
      bestSellNetBps: best.sell?.bps ?? null,
      bestBuySizeUsd: best.buy?.size ?? null,
      bestSellSizeUsd: best.sell?.size ?? null,
      quoteAgeMs,
    };
  });

  return {
    panels,
    heartbeat: hb
      ? {
          observedAt: hb.observedAt.toISOString(),
          activePairs: hb.activePairCount,
          currentRps: hb.currentRps,
          http429Count1m: hb.http429Count1m,
          streamLagMs: hb.streamLagMs,
          quoteLagMs: hb.quoteLagMs,
        }
      : null,
  };
}
