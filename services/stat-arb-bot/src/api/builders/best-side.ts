/** Quality-safe best-side selection.
 *
 *  The bot's old api-server picked the row with the most favorable ratio
 *  regardless of `qualityStatus`, so a single stale or invalid row could
 *  surface as the headline opportunity. The new builders separate two layers:
 *
 *    - `pickBestLive(...)` returns only LIVE_ELIGIBLE rows.
 *    - `pickBestDiagnostic(...)` falls back to the best row across any
 *      quality status so the operator can still see "warm" or "stale" rows
 *      for diagnostic purposes.
 *
 *  The Vercel dashboard must never show a stale row in the primary slot. */

import type {
  BestSideDto,
  PairDirection,
  TimeRegime,
} from "@sotama/market-core";
import {
  describeDisplayBasis,
  type QuoteQualityStatus,
} from "@sotama/market-core";

export type CandidateRow = {
  side: PairDirection;
  sizeUsd: number;
  netBps: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  observedAt: Date;
  timeRegime: TimeRegime | null;
  quality?: "live" | "warm" | "stale" | "invalid";
  qualityStatus?: QuoteQualityStatus;
  qualityReason?: string;
  pythFreshnessLagMs?: number | null;
  pythConfidenceBps?: number | null;
  basisAgeMs?: number | null;
};

export function pickBestLive(
  rows: Iterable<CandidateRow>,
  kind: "buy" | "sell",
): BestSideDto | null {
  return pickBest(rows, kind, (row) => row.qualityStatus === "LIVE_ELIGIBLE");
}

export function pickBestDiagnostic(
  rows: Iterable<CandidateRow>,
  kind: "buy" | "sell",
): BestSideDto | null {
  return pickBest(rows, kind, () => true);
}

function pickBest(
  rows: Iterable<CandidateRow>,
  kind: "buy" | "sell",
  filter: (row: CandidateRow) => boolean,
): BestSideDto | null {
  let best: BestSideDto | null = null;
  for (const row of rows) {
    if (!filter(row)) continue;
    if (row.basePriceUsd <= 0 || row.tokenPriceUsd <= 0) continue;
    const ratio = row.tokenPriceUsd / row.basePriceUsd;
    const candidate = toBestSideDto(row, ratio);
    if (!best) {
      best = candidate;
      continue;
    }
    const better = kind === "buy" ? ratio < best.ratio : ratio > best.ratio;
    if (better) best = candidate;
  }
  return best;
}

function toBestSideDto(row: CandidateRow, ratio: number): BestSideDto {
  const { basisBps, interpretation } = describeDisplayBasis({
    tokenPriceUsd: row.tokenPriceUsd,
    basePriceUsd: row.basePriceUsd,
  });
  return {
    ratio,
    side: row.side,
    sizeUsd: row.sizeUsd,
    netBps: row.netBps,
    basePriceUsd: row.basePriceUsd,
    tokenPriceUsd: row.tokenPriceUsd,
    observedAt: row.observedAt.toISOString(),
    timeRegime: row.timeRegime ?? null,
    quality: row.quality,
    qualityStatus: row.qualityStatus,
    qualityReason: row.qualityReason,
    pythFreshnessLagMs: row.pythFreshnessLagMs ?? null,
    pythConfidenceBps: row.pythConfidenceBps ?? null,
    basisAgeMs: row.basisAgeMs ?? null,
    displayBasisBps: basisBps,
    displayBasisInterpretation: interpretation,
  };
}
