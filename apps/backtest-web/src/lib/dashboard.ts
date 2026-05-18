import { listAllPairs, latestBasisPerKey, latestHeartbeat } from "@sotama/db";
import type { BasisObservationRow } from "@sotama/db";
import type { PairConfig } from "@sotama/market-core";

/** Best observation on one side of a pair. `ratio = tokenPrice / basePrice`.
 *  - For buy: a ratio < 1 means the tokenized asset trades below reference
 *    (favorable entry). "Best buy" = lowest observed ratio across sizes.
 *  - For sell: a ratio > 1 means the tokenized asset trades above reference
 *    (favorable exit). "Best sell" = highest observed ratio across sizes. */
export type BestSide = {
  ratio: number;
  sizeUsd: number;
  netBps: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  observedAt: Date;
};

/** Round-trip cost (or arb gap if negative) at the smallest spread size.
 *  `spreadBps = (buyTokenPrice - sellTokenPrice) / mid * 10000`.
 *  Only computed when both directions have a fresh observation at the
 *  same size — otherwise null on the panel. */
export type BestSpread = {
  spreadBps: number;
  sizeUsd: number;
  buyTokenPriceUsd: number;
  sellTokenPriceUsd: number;
  observedAt: Date;
};

export type PairPanel = {
  pair: PairConfig;
  bestBuy: BestSide | null;
  bestSell: BestSide | null;
  bestSpread: BestSpread | null;
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

  const byPair = new Map<
    string,
    { buyBySize: Map<number, BasisObservationRow>; sellBySize: Map<number, BasisObservationRow> }
  >();
  for (const b of basis) {
    const e = byPair.get(b.pairId) ?? {
      buyBySize: new Map<number, BasisObservationRow>(),
      sellBySize: new Map<number, BasisObservationRow>(),
    };
    if (b.side === "buy_tokenized") e.buyBySize.set(b.sizeUsd, b);
    else e.sellBySize.set(b.sizeUsd, b);
    byPair.set(b.pairId, e);
  }

  const now = Date.now();
  const panels: PairPanel[] = pairs.map((pair) => {
    const e =
      byPair.get(pair.id) ?? {
        buyBySize: new Map<number, BasisObservationRow>(),
        sellBySize: new Map<number, BasisObservationRow>(),
      };

    const bestBuy = pickBest(e.buyBySize.values(), "buy");
    const bestSell = pickBest(e.sellBySize.values(), "sell");
    const bestSpread = pickBestSpread(e.buyBySize, e.sellBySize);

    const ages: number[] = [];
    if (bestBuy) ages.push(now - bestBuy.observedAt.getTime());
    if (bestSell) ages.push(now - bestSell.observedAt.getTime());
    const quoteAgeMs = ages.length === 0 ? null : Math.min(...ages);

    return { pair, bestBuy, bestSell, bestSpread, quoteAgeMs };
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

function pickBest(
  iter: Iterable<BasisObservationRow>,
  kind: "buy" | "sell",
): BestSide | null {
  let best: BestSide | null = null;
  for (const b of iter) {
    if (b.basePriceUsd <= 0) continue;
    const ratio = b.tokenPriceUsd / b.basePriceUsd;
    if (!best) {
      best = toBest(b, ratio);
      continue;
    }
    const better = kind === "buy" ? ratio < best.ratio : ratio > best.ratio;
    if (better) best = toBest(b, ratio);
  }
  return best;
}

function toBest(b: BasisObservationRow, ratio: number): BestSide {
  return {
    ratio,
    sizeUsd: b.sizeUsd,
    netBps: b.netBps,
    basePriceUsd: b.basePriceUsd,
    tokenPriceUsd: b.tokenPriceUsd,
    observedAt: b.observedAt,
  };
}

function pickBestSpread(
  buyBySize: Map<number, BasisObservationRow>,
  sellBySize: Map<number, BasisObservationRow>,
): BestSpread | null {
  let best: BestSpread | null = null;
  for (const [size, buyRow] of buyBySize) {
    const sellRow = sellBySize.get(size);
    if (!sellRow) continue;
    const mid = (buyRow.tokenPriceUsd + sellRow.tokenPriceUsd) / 2;
    if (mid <= 0) continue;
    const spreadBps = ((buyRow.tokenPriceUsd - sellRow.tokenPriceUsd) / mid) * 10000;
    const candidate: BestSpread = {
      spreadBps,
      sizeUsd: size,
      buyTokenPriceUsd: buyRow.tokenPriceUsd,
      sellTokenPriceUsd: sellRow.tokenPriceUsd,
      observedAt: new Date(
        Math.max(buyRow.observedAt.getTime(), sellRow.observedAt.getTime()),
      ),
    };
    if (!best || Math.abs(spreadBps) < Math.abs(best.spreadBps)) best = candidate;
  }
  return best;
}
