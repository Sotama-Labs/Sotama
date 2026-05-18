/** Quote surface, basis series, quality distribution, and regime breakdown
 *  DTO mappers. */

import type {
  BasisObservationRow,
  TimeRegimeSummaryRow,
} from "@sotama/db";
import type {
  AssetClass,
  BasisSeriesPointDto,
  QuoteQualityDistributionDto,
  QuoteSurfaceRowDto,
  TimeRegime,
  TimeRegimeSummaryDto,
} from "@sotama/market-core";
import { describeDisplayBasis } from "@sotama/market-core";

export function toQuoteSurface(rows: BasisObservationRow[]): QuoteSurfaceRowDto[] {
  return [...rows]
    .sort((a, b) => a.sizeUsd - b.sizeUsd || a.side.localeCompare(b.side))
    .map((b) => {
      const { basisBps, interpretation } = describeDisplayBasis({
        tokenPriceUsd: b.tokenPriceUsd,
        basePriceUsd: b.basePriceUsd,
      });
      return {
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
        displayBasisBps: basisBps,
        displayBasisInterpretation: interpretation,
      };
    });
}

export function toBasisSeriesPoint(b: BasisObservationRow): BasisSeriesPointDto {
  const { basisBps } = describeDisplayBasis({
    tokenPriceUsd: b.tokenPriceUsd,
    basePriceUsd: b.basePriceUsd,
  });
  return {
    side: b.side,
    sizeUsd: b.sizeUsd,
    netBps: b.netBps,
    tokenPriceUsd: b.tokenPriceUsd,
    quality: b.quality ?? "live",
    qualityStatus: b.qualityStatus ?? "LIVE_ELIGIBLE",
    timeRegime: b.timeRegime ?? null,
    observedAt: b.observedAt.toISOString(),
    displayBasisBps: basisBps,
  };
}

export function toQualityDistribution(
  rows: Array<{
    qualityStatus: QuoteQualityDistributionDto["qualityStatus"];
    observationCount: number;
    observationPct: number;
  }>,
): QuoteQualityDistributionDto[] {
  return rows.map((row) => ({
    qualityStatus: row.qualityStatus,
    observationCount: row.observationCount,
    observationPct: row.observationPct,
  }));
}

export function toTimeRegimeSummary(
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

export function downsample<T>(rows: T[], limit: number): T[] {
  if (rows.length <= limit) return rows;
  const step = rows.length / limit;
  const out: T[] = [];
  for (let i = 0; i < limit; i += 1) {
    out.push(rows[Math.floor(i * step)]!);
  }
  return out;
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
