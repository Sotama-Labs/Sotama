/** Build a `PairPanelDto` from the latest basis rows for a pair.
 *
 *  Quality-safe by default: `currentOpportunity` only carries LIVE_ELIGIBLE
 *  rows that pair to a synchronized opposite-side row. `bestDiagnosticBuy`
 *  / `bestDiagnosticSell` carry the freshest row regardless of quality so
 *  the operator still sees diagnostic data.
 *
 *  Legacy `bestBuy/Sell/Spread` fields stay populated with the diagnostic
 *  view so older dashboards keep rendering until they cut over. */

import type { BasisObservationRow } from "@sotama/db";
import type {
  BestSideDto,
  BestSpreadDto,
  CurrentOpportunityDto,
  PairConfig,
} from "@sotama/market-core";
import {
  deriveOrientation,
  type PairOrientation,
} from "../orientation";
import { pickBestDiagnostic, pickBestLive, type CandidateRow } from "./best-side";
import {
  pickDiagnosticSpread,
  pickSynchronizedSpread,
  type SpreadCandidateRow,
} from "./synchronized-spread";
import { MAX_SYNC_AGE_GAP_MS } from "../constants";

export type PairBuckets = {
  buyBySize: Map<number, BasisObservationRow>;
  sellBySize: Map<number, BasisObservationRow>;
};

export function groupBasisByPair(
  basis: readonly BasisObservationRow[],
): Map<string, PairBuckets> {
  const out = new Map<string, PairBuckets>();
  for (const b of basis) {
    const cur = ensureBucket(out, b.pairId);
    if (b.side === "buy_tokenized") cur.buyBySize.set(b.sizeUsd, b);
    else cur.sellBySize.set(b.sizeUsd, b);
  }
  return out;
}

function ensureBucket(
  map: Map<string, PairBuckets>,
  pairId: string,
): PairBuckets {
  const existing = map.get(pairId);
  if (existing) return existing;
  const created: PairBuckets = {
    buyBySize: new Map<number, BasisObservationRow>(),
    sellBySize: new Map<number, BasisObservationRow>(),
  };
  map.set(pairId, created);
  return created;
}

export type PanelCore = {
  orientation: PairOrientation;
  currentOpportunity: CurrentOpportunityDto;
  bestDiagnosticBuy: BestSideDto | null;
  bestDiagnosticSell: BestSideDto | null;
  bestBuy: BestSideDto | null;
  bestSell: BestSideDto | null;
  bestSpread: BestSpreadDto | null;
  quoteAgeMs: number | null;
};

export function buildPanelCore(args: {
  pair: PairConfig;
  buckets: PairBuckets;
  nowMs: number;
  maxPythFreshnessLagMs?: number | null;
}): PanelCore {
  const buyCandidates = toCandidates([...args.buckets.buyBySize.values()]);
  const sellCandidates = toCandidates([...args.buckets.sellBySize.values()]);

  const liveBuy = pickBestLive(buyCandidates, "buy");
  const liveSell = pickBestLive(sellCandidates, "sell");
  const diagnosticBuy = pickBestDiagnostic(buyCandidates, "buy");
  const diagnosticSell = pickBestDiagnostic(sellCandidates, "sell");

  const liveSpread = pickSynchronizedSpread({
    buyBySize: args.buckets.buyBySize,
    sellBySize: args.buckets.sellBySize,
    maxAgeGapMs: MAX_SYNC_AGE_GAP_MS,
  });
  const diagnosticSpread = pickDiagnosticSpread({
    buyBySize: args.buckets.buyBySize,
    sellBySize: args.buckets.sellBySize,
  });

  const quoteAgeMs = minAgeMs(
    args.nowMs,
    [liveBuy?.observedAt, liveSell?.observedAt]
      .filter((iso): iso is string => typeof iso === "string"),
  );

  const orientation = deriveOrientation({
    pair: args.pair,
    timeRegime: liveBuy?.timeRegime ?? liveSell?.timeRegime ?? diagnosticBuy?.timeRegime ?? null,
    pythFreshnessLagMs:
      liveBuy?.pythFreshnessLagMs ??
      liveSell?.pythFreshnessLagMs ??
      diagnosticBuy?.pythFreshnessLagMs ??
      null,
    maxPythFreshnessLagMs: args.maxPythFreshnessLagMs ?? null,
  });

  const hasLiveOpportunity = liveBuy != null || liveSell != null;
  const notExecutableReason = hasLiveOpportunity
    ? null
    : reasonForNoLiveRow({ diagnosticBuy, diagnosticSell });

  const currentOpportunity: CurrentOpportunityDto = {
    hasLiveOpportunity,
    bestBuy: liveBuy,
    bestSell: liveSell,
    roundTripSpread: liveSpread,
    quoteAgeMs,
    notExecutableReason,
  };

  return {
    orientation,
    currentOpportunity,
    bestDiagnosticBuy: diagnosticBuy,
    bestDiagnosticSell: diagnosticSell,
    bestBuy: diagnosticBuy,
    bestSell: diagnosticSell,
    bestSpread: liveSpread ?? diagnosticSpread,
    quoteAgeMs,
  };
}

function toCandidates(rows: readonly BasisObservationRow[]): CandidateRow[] {
  return rows.map((row) => ({
    side: row.side,
    sizeUsd: row.sizeUsd,
    netBps: row.netBps,
    basePriceUsd: row.basePriceUsd,
    tokenPriceUsd: row.tokenPriceUsd,
    observedAt: row.observedAt,
    timeRegime: row.timeRegime ?? null,
    quality: row.quality,
    qualityStatus: row.qualityStatus,
    qualityReason: row.qualityReason,
    pythFreshnessLagMs: row.pythFreshnessLagMs,
    pythConfidenceBps: row.pythConfidenceBps,
    basisAgeMs: row.basisAgeMs,
  }));
}

function minAgeMs(nowMs: number, iso: readonly string[]): number | null {
  const ages = iso.map((s) => nowMs - new Date(s).getTime());
  return ages.length === 0 ? null : Math.min(...ages);
}

function reasonForNoLiveRow(args: {
  diagnosticBuy: BestSideDto | null;
  diagnosticSell: BestSideDto | null;
}): string {
  const row = args.diagnosticBuy ?? args.diagnosticSell;
  if (!row) return "No quotes have been collected for this pair yet.";
  switch (row.qualityStatus) {
    case "STALE_PYTH":
      return "Pyth reference is stale — onchain quote remains, but no executable basis.";
    case "STALE_BASIS":
      return "Basis observation is stale — last quote landed too late to act on.";
    case "QUOTE_LATENCY_TOO_HIGH":
      return "Jupiter quote latency exceeded the live-eligibility threshold.";
    case "MARKET_SESSION_INVALID":
      return "Off-session for the underlying reference — closed-market basis only.";
    case "PRICE_IMPACT_TOO_HIGH":
      return "Last quote's price impact exceeded the live-eligibility threshold.";
    case "PYTH_CONFIDENCE_TOO_WIDE":
      return "Pyth confidence band is wider than the live-eligibility threshold.";
    case "UNKNOWN_ROUTER":
      return "Jupiter returned an unknown router; awaiting allowlist before flagging live.";
    case "ROUTE_UNSTABLE":
      return "Route is currently unstable; the live opportunity slot is gated.";
    case "MISSING_EXIT_QUOTE":
      return "Opposite-side exit quote is missing — no synchronized round-trip.";
    case "DECIMALS_UNVERIFIED":
      return "Token mint decimals have not been verified on-chain.";
    default:
      return "No live-eligible quote in the latest window.";
  }
}
