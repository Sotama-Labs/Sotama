import type { PairDirection } from "./pair-config";
import type { QuoteQualityStatus } from "./quote-quality";

export type HoldHorizonObservation = {
  side: PairDirection;
  sizeUsd: number;
  observedAtMs: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  netBps: number;
  qualityStatus: QuoteQualityStatus | null | undefined;
};

export type HoldHorizonSizeResult = {
  sizeUsd: number;
  pnlUsd: number;
  closedTrades: number;
  winningTrades: number;
  timedOutTrades: number;
  openPositions: number;
  deployedUsd: number;
  returnPct: number;
  annualizedReturnPct: number | null;
  avgRatioMoveBps: number | null;
  winRate: number;
  avgHoldSeconds: number;
};

export type HoldHorizonReplayRow = {
  horizonMs: number;
  sampleWindowMs: number;
  horizonCovered: boolean;
  pnlUsd: number;
  closedTrades: number;
  winningTrades: number;
  timedOutTrades: number;
  openPositions: number;
  deployedUsd: number;
  returnPct: number;
  annualizedReturnPct: number | null;
  avgRatioMoveBps: number | null;
  winRate: number;
  avgHoldSeconds: number;
  sizeResults: HoldHorizonSizeResult[];
};

export type HoldHorizonReplayOptions = {
  minNetEdgeBps: number;
  transactionCostBps: number;
  horizonsMs: readonly number[];
};

type Position = {
  sizeUsd: number;
  tokenUnits: number;
  entryAtMs: number;
  entryRatio: number | null;
};

type MutableSizeResult = Omit<HoldHorizonSizeResult, "winRate" | "avgHoldSeconds"> & {
  holdSecondsSum: number;
  deployedUsdSeconds: number;
  ratioMoveBpsSum: number;
  ratioMoveCount: number;
};

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export function runHoldHorizonReplay(args: {
  observations: readonly HoldHorizonObservation[];
  options: HoldHorizonReplayOptions;
}): HoldHorizonReplayRow[] {
  const rows = args.observations
    .filter((row) => row.qualityStatus === "LIVE_ELIGIBLE")
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  const sampleWindowMs =
    rows.length < 2 ? 0 : rows[rows.length - 1]!.observedAtMs - rows[0]!.observedAtMs;
  return args.options.horizonsMs.map((horizonMs) =>
    runOneHorizon(rows, horizonMs, sampleWindowMs, args.options),
  );
}

function runOneHorizon(
  rows: readonly HoldHorizonObservation[],
  horizonMs: number,
  sampleWindowMs: number,
  options: HoldHorizonReplayOptions,
): HoldHorizonReplayRow {
  const positions = new Map<number, Position>();
  const sellRouteSeen = new Set<number>();
  const results = new Map<number, MutableSizeResult>();

  for (const row of rows) {
    ensureResult(results, row.sizeUsd);
    if (row.side === "sell_tokenized") {
      sellRouteSeen.add(row.sizeUsd);
      maybeClose(row, horizonMs, positions, results, options.transactionCostBps);
      continue;
    }
    maybeOpen(row, sellRouteSeen, positions, options.minNetEdgeBps);
  }

  for (const [sizeUsd, position] of positions) {
    ensureResult(results, sizeUsd).openPositions += 1;
    void position;
  }

  const resultRows = [...results.values()].sort((a, b) => a.sizeUsd - b.sizeUsd);
  const totals = resultRows.reduce(
    (acc, row) => {
      acc.pnlUsd += row.pnlUsd;
      acc.closedTrades += row.closedTrades;
      acc.winningTrades += row.winningTrades;
      acc.timedOutTrades += row.timedOutTrades;
      acc.openPositions += row.openPositions;
      acc.deployedUsd += row.deployedUsd;
      acc.holdSecondsSum += row.holdSecondsSum;
      acc.deployedUsdSeconds += row.deployedUsdSeconds;
      acc.ratioMoveBpsSum += row.ratioMoveBpsSum;
      acc.ratioMoveCount += row.ratioMoveCount;
      return acc;
    },
    {
      pnlUsd: 0,
      closedTrades: 0,
      winningTrades: 0,
      timedOutTrades: 0,
      openPositions: 0,
      deployedUsd: 0,
      returnPct: 0,
      annualizedReturnPct: null,
      avgRatioMoveBps: null,
      holdSecondsSum: 0,
      deployedUsdSeconds: 0,
      ratioMoveBpsSum: 0,
      ratioMoveCount: 0,
    },
  );
  const sizeResults = resultRows.map(finalizeSizeResult);
  return {
    horizonMs,
    sampleWindowMs,
    horizonCovered: sampleWindowMs >= horizonMs,
    pnlUsd: totals.pnlUsd,
    closedTrades: totals.closedTrades,
    winningTrades: totals.winningTrades,
    timedOutTrades: totals.timedOutTrades,
    openPositions: totals.openPositions,
    deployedUsd: totals.deployedUsd,
    returnPct: computeReturnPct(totals.pnlUsd, totals.deployedUsd),
    annualizedReturnPct: computeAnnualizedReturnPct(
      totals.pnlUsd,
      totals.deployedUsdSeconds,
    ),
    avgRatioMoveBps: computeAverageRatioMoveBps(
      totals.ratioMoveBpsSum,
      totals.ratioMoveCount,
    ),
    winRate: totals.closedTrades === 0 ? 0 : totals.winningTrades / totals.closedTrades,
    avgHoldSeconds:
      totals.closedTrades === 0 ? 0 : totals.holdSecondsSum / totals.closedTrades,
    sizeResults,
  };
}

function maybeOpen(
  row: HoldHorizonObservation,
  sellRouteSeen: Set<number>,
  positions: Map<number, Position>,
  minNetEdgeBps: number,
): void {
  if (positions.has(row.sizeUsd)) return;
  if (!sellRouteSeen.has(row.sizeUsd)) return;
  if (row.netBps < minNetEdgeBps) return;
  if (row.tokenPriceUsd <= 0) return;
  positions.set(row.sizeUsd, {
    sizeUsd: row.sizeUsd,
    tokenUnits: row.sizeUsd / row.tokenPriceUsd,
    entryAtMs: row.observedAtMs,
    entryRatio: computeRatio(row),
  });
}

function maybeClose(
  row: HoldHorizonObservation,
  horizonMs: number,
  positions: Map<number, Position>,
  results: Map<number, MutableSizeResult>,
  transactionCostBps: number,
): void {
  const position = positions.get(row.sizeUsd);
  if (!position || row.observedAtMs <= position.entryAtMs) return;
  const pnlUsd = computeSpotExitPnlUsd({
    sizeUsd: position.sizeUsd,
    tokenUnits: position.tokenUnits,
    exitTokenPriceUsd: row.tokenPriceUsd,
    transactionCostBps,
  });
  const profitable = pnlUsd >= 0;
  const timedOut = row.observedAtMs - position.entryAtMs >= horizonMs;
  if (!profitable && !timedOut) return;

  const result = ensureResult(results, row.sizeUsd);
  result.pnlUsd += pnlUsd;
  result.closedTrades += 1;
  if (pnlUsd > 0.01) result.winningTrades += 1;
  if (timedOut && !profitable) result.timedOutTrades += 1;
  const holdSeconds = (row.observedAtMs - position.entryAtMs) / 1000;
  result.deployedUsd += position.sizeUsd;
  result.holdSecondsSum += holdSeconds;
  result.deployedUsdSeconds += position.sizeUsd * holdSeconds;
  const ratioMoveBps = computeRatioMoveBps(position.entryRatio, computeRatio(row));
  if (ratioMoveBps != null) {
    result.ratioMoveBpsSum += ratioMoveBps;
    result.ratioMoveCount += 1;
  }
  positions.delete(row.sizeUsd);
}

function ensureResult(
  results: Map<number, MutableSizeResult>,
  sizeUsd: number,
): MutableSizeResult {
  const existing = results.get(sizeUsd);
  if (existing) return existing;
  const created: MutableSizeResult = {
    sizeUsd,
    pnlUsd: 0,
    closedTrades: 0,
    winningTrades: 0,
    timedOutTrades: 0,
    openPositions: 0,
    deployedUsd: 0,
    returnPct: 0,
    annualizedReturnPct: null,
    avgRatioMoveBps: null,
    holdSecondsSum: 0,
    deployedUsdSeconds: 0,
    ratioMoveBpsSum: 0,
    ratioMoveCount: 0,
  };
  results.set(sizeUsd, created);
  return created;
}

function finalizeSizeResult(row: MutableSizeResult): HoldHorizonSizeResult {
  return {
    sizeUsd: row.sizeUsd,
    pnlUsd: row.pnlUsd,
    closedTrades: row.closedTrades,
    winningTrades: row.winningTrades,
    timedOutTrades: row.timedOutTrades,
    openPositions: row.openPositions,
    deployedUsd: row.deployedUsd,
    returnPct: computeReturnPct(row.pnlUsd, row.deployedUsd),
    annualizedReturnPct: computeAnnualizedReturnPct(row.pnlUsd, row.deployedUsdSeconds),
    avgRatioMoveBps: computeAverageRatioMoveBps(row.ratioMoveBpsSum, row.ratioMoveCount),
    winRate: row.closedTrades === 0 ? 0 : row.winningTrades / row.closedTrades,
    avgHoldSeconds: row.closedTrades === 0 ? 0 : row.holdSecondsSum / row.closedTrades,
  };
}

function computeReturnPct(pnlUsd: number, deployedUsd: number): number {
  return deployedUsd === 0 ? 0 : pnlUsd / deployedUsd;
}

function computeAnnualizedReturnPct(
  pnlUsd: number,
  deployedUsdSeconds: number,
): number | null {
  return deployedUsdSeconds === 0 ? null : (pnlUsd * SECONDS_PER_YEAR) / deployedUsdSeconds;
}

function computeAverageRatioMoveBps(
  ratioMoveBpsSum: number,
  ratioMoveCount: number,
): number | null {
  return ratioMoveCount === 0 ? null : ratioMoveBpsSum / ratioMoveCount;
}

function computeRatio(row: HoldHorizonObservation): number | null {
  return row.basePriceUsd > 0 && row.tokenPriceUsd > 0
    ? row.tokenPriceUsd / row.basePriceUsd
    : null;
}

function computeRatioMoveBps(
  entryRatio: number | null,
  exitRatio: number | null,
): number | null {
  if (entryRatio == null || exitRatio == null || entryRatio <= 0) return null;
  return (exitRatio / entryRatio - 1) * 10000;
}

function computeSpotExitPnlUsd(args: {
  sizeUsd: number;
  tokenUnits: number;
  exitTokenPriceUsd: number;
  transactionCostBps: number;
}): number {
  const exitGrossUsd = args.tokenUnits * args.exitTokenPriceUsd;
  const entryCostsUsd = args.sizeUsd * (args.transactionCostBps / 10000);
  const exitCostsUsd = exitGrossUsd * (args.transactionCostBps / 10000);
  return exitGrossUsd - args.sizeUsd - entryCostsUsd - exitCostsUsd;
}
