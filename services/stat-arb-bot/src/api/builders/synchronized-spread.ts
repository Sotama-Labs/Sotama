/** Synchronized round-trip spread.
 *
 *  The old `pickBestSpread` matched buy/sell rows by size, ignoring the time
 *  gap between them and their quality status. That can surface a "great
 *  spread" from a stale buy paired with a fresh sell — the kind of artifact
 *  the holistic review explicitly warned against.
 *
 *  This builder requires both legs to be LIVE_ELIGIBLE and observed within
 *  `MAX_SYNC_AGE_GAP_MS` of each other. */

import type { BestSpreadDto, PairDirection, TimeRegime } from "@sotama/market-core";
import type { QuoteQualityStatus } from "@sotama/market-core";

export type SpreadCandidateRow = {
  side: PairDirection;
  sizeUsd: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  observedAt: Date;
  qualityStatus?: QuoteQualityStatus;
  timeRegime?: TimeRegime | null;
};

export function pickSynchronizedSpread(args: {
  buyBySize: ReadonlyMap<number, SpreadCandidateRow>;
  sellBySize: ReadonlyMap<number, SpreadCandidateRow>;
  maxAgeGapMs: number;
}): BestSpreadDto | null {
  let best: BestSpreadDto | null = null;
  for (const [size, buyRow] of args.buyBySize) {
    const sellRow = args.sellBySize.get(size);
    if (!sellRow) continue;
    if (
      buyRow.qualityStatus !== "LIVE_ELIGIBLE" ||
      sellRow.qualityStatus !== "LIVE_ELIGIBLE"
    ) {
      continue;
    }
    const ageGapMs = Math.abs(
      buyRow.observedAt.getTime() - sellRow.observedAt.getTime(),
    );
    if (ageGapMs > args.maxAgeGapMs) continue;
    const candidate = buildSpread(buyRow, sellRow, ageGapMs, true);
    if (!candidate) continue;
    if (!best || Math.abs(candidate.spreadBps) < Math.abs(best.spreadBps)) {
      best = candidate;
    }
  }
  return best;
}

/** Diagnostic-only spread that ignores quality + age gap. Used when the live
 *  selector returns null and the operator wants to see *something* in the
 *  "round-trip spread" slot. The DTO carries `synchronized=false` so the UI
 *  can present it muted. */
export function pickDiagnosticSpread(args: {
  buyBySize: ReadonlyMap<number, SpreadCandidateRow>;
  sellBySize: ReadonlyMap<number, SpreadCandidateRow>;
}): BestSpreadDto | null {
  let best: BestSpreadDto | null = null;
  for (const [size, buyRow] of args.buyBySize) {
    const sellRow = args.sellBySize.get(size);
    if (!sellRow) continue;
    const ageGapMs = Math.abs(
      buyRow.observedAt.getTime() - sellRow.observedAt.getTime(),
    );
    const candidate = buildSpread(buyRow, sellRow, ageGapMs, false);
    if (!candidate) continue;
    if (!best || Math.abs(candidate.spreadBps) < Math.abs(best.spreadBps)) {
      best = candidate;
    }
  }
  return best;
}

function buildSpread(
  buyRow: SpreadCandidateRow,
  sellRow: SpreadCandidateRow,
  ageGapMs: number,
  synchronized: boolean,
): BestSpreadDto | null {
  const mid = (buyRow.tokenPriceUsd + sellRow.tokenPriceUsd) / 2;
  if (mid <= 0) return null;
  return {
    spreadBps: ((buyRow.tokenPriceUsd - sellRow.tokenPriceUsd) / mid) * 10000,
    sizeUsd: buyRow.sizeUsd,
    buyTokenPriceUsd: buyRow.tokenPriceUsd,
    sellTokenPriceUsd: sellRow.tokenPriceUsd,
    observedAt: new Date(
      Math.max(buyRow.observedAt.getTime(), sellRow.observedAt.getTime()),
    ).toISOString(),
    synchronized,
    maxAgeGapMs: ageGapMs,
  };
}
