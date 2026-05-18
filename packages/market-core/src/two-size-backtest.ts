import type { PairDirection } from "./pair-config";
import type { QuoteQualityStatus } from "./quote-quality";

export type TwoSizeRecommendedAction =
  | "DO_NOTHING"
  | "TRADE_250"
  | "TRADE_1000"
  | "RESEARCH_ONLY";

export type TwoSizeSkipReason =
  | "NON_LIVE"
  | "EDGE_BELOW_THRESHOLD"
  | "MISSING_EXIT_QUOTE"
  | "POSITION_ALREADY_OPEN"
  | "EXIT_NOT_PROFITABLE";

export type TwoSizeBacktestObservation = {
  side: PairDirection;
  sizeUsd: number;
  observedAtMs: number;
  basePriceUsd: number;
  tokenPriceUsd: number;
  netBps: number;
  qualityStatus: QuoteQualityStatus | null | undefined;
};

export type TwoSizeBacktestSizeResult = {
  sizeUsd: 250 | 1000;
  latestEdgeBps: number | null;
  pnlUsd: number;
  closedTrades: number;
  openPositions: number;
};

export type TwoSizeBacktestV2Result = {
  edge250Bps: number | null;
  edge1000Bps: number | null;
  pnl250: number;
  pnl1000: number;
  edgeNext750Bps: number | null;
  recommendedAction: TwoSizeRecommendedAction;
  sizeResults: TwoSizeBacktestSizeResult[];
  liveEligibleCount: number;
  skippedSignalReasons: Array<{ reason: TwoSizeSkipReason; count: number }>;
};

export type TwoSizeBacktestOptions = {
  minNetEdgeBps: number;
  transactionCostBps: number;
  minLiveSamples: number;
  researchOnly?: boolean;
};

type Position = {
  tokenUnits: number;
  entryAtMs: number;
};

const SIZES = [250, 1000] as const;

export function runTwoSizeBacktestV2(args: {
  observations: readonly TwoSizeBacktestObservation[];
  options: TwoSizeBacktestOptions;
}): TwoSizeBacktestV2Result {
  const rows = args.observations
    .filter((row) => SIZES.includes(row.sizeUsd as 250 | 1000))
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  const latestBuy = new Map<number, TwoSizeBacktestObservation>();
  const latestSell = new Map<number, TwoSizeBacktestObservation>();
  const positions = new Map<number, Position>();
  const pnl = new Map<number, number>(SIZES.map((size) => [size, 0]));
  const closed = new Map<number, number>(SIZES.map((size) => [size, 0]));
  const skipped = new Map<TwoSizeSkipReason, number>();
  let liveEligibleCount = 0;

  for (const row of rows) {
    if (row.qualityStatus !== "LIVE_ELIGIBLE") {
      inc(skipped, "NON_LIVE");
      continue;
    }
    liveEligibleCount += 1;
    if (row.side === "buy_tokenized") {
      latestBuy.set(row.sizeUsd, row);
      maybeOpen(row, latestSell, positions, skipped, args.options);
      continue;
    }
    latestSell.set(row.sizeUsd, row);
    maybeClose(row, positions, pnl, closed, skipped, args.options);
  }

  const edge250Bps = latestBuy.get(250)?.netBps ?? null;
  const edge1000Bps = latestBuy.get(1000)?.netBps ?? null;
  const edgeNext750Bps = marginalNext750EdgeBps(
    latestBuy.get(250),
    latestBuy.get(1000),
    args.options.transactionCostBps,
  );
  const sizeResults: TwoSizeBacktestSizeResult[] = SIZES.map((size) => ({
    sizeUsd: size,
    latestEdgeBps: latestBuy.get(size)?.netBps ?? null,
    pnlUsd: pnl.get(size) ?? 0,
    closedTrades: closed.get(size) ?? 0,
    openPositions: positions.has(size) ? 1 : 0,
  }));

  return {
    edge250Bps,
    edge1000Bps,
    pnl250: pnl.get(250) ?? 0,
    pnl1000: pnl.get(1000) ?? 0,
    edgeNext750Bps,
    recommendedAction: recommendAction({
      edge250Bps,
      edge1000Bps,
      edgeNext750Bps,
      liveEligibleCount,
      options: args.options,
    }),
    sizeResults,
    liveEligibleCount,
    skippedSignalReasons: [...skipped.entries()].map(([reason, count]) => ({ reason, count })),
  };
}

function maybeOpen(
  row: TwoSizeBacktestObservation,
  latestSell: Map<number, TwoSizeBacktestObservation>,
  positions: Map<number, Position>,
  skipped: Map<TwoSizeSkipReason, number>,
  options: TwoSizeBacktestOptions,
): void {
  if (row.netBps < options.minNetEdgeBps) {
    inc(skipped, "EDGE_BELOW_THRESHOLD");
    return;
  }
  if (positions.has(row.sizeUsd)) {
    inc(skipped, "POSITION_ALREADY_OPEN");
    return;
  }
  if (!latestSell.has(row.sizeUsd)) {
    inc(skipped, "MISSING_EXIT_QUOTE");
    return;
  }
  if (row.tokenPriceUsd <= 0) return;
  positions.set(row.sizeUsd, {
    tokenUnits: row.sizeUsd / row.tokenPriceUsd,
    entryAtMs: row.observedAtMs,
  });
}

function maybeClose(
  row: TwoSizeBacktestObservation,
  positions: Map<number, Position>,
  pnl: Map<number, number>,
  closed: Map<number, number>,
  skipped: Map<TwoSizeSkipReason, number>,
  options: TwoSizeBacktestOptions,
): void {
  const position = positions.get(row.sizeUsd);
  if (!position || row.observedAtMs <= position.entryAtMs) return;
  const exitPnl = computeSpotExitPnlUsd({
    sizeUsd: row.sizeUsd,
    tokenUnits: position.tokenUnits,
    exitTokenPriceUsd: row.tokenPriceUsd,
    transactionCostBps: options.transactionCostBps,
  });
  if (exitPnl < 0) {
    inc(skipped, "EXIT_NOT_PROFITABLE");
    return;
  }
  pnl.set(row.sizeUsd, (pnl.get(row.sizeUsd) ?? 0) + exitPnl);
  closed.set(row.sizeUsd, (closed.get(row.sizeUsd) ?? 0) + 1);
  positions.delete(row.sizeUsd);
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

function marginalNext750EdgeBps(
  buy250: TwoSizeBacktestObservation | undefined,
  buy1000: TwoSizeBacktestObservation | undefined,
  transactionCostBps: number,
): number | null {
  if (!buy250 || !buy1000) return null;
  if (buy250.basePriceUsd <= 0 || buy1000.basePriceUsd <= 0) return null;
  if (buy250.tokenPriceUsd <= 0 || buy1000.tokenPriceUsd <= 0) return null;
  const out250 = 250 / buy250.tokenPriceUsd;
  const out1000 = 1000 / buy1000.tokenPriceUsd;
  const outNext750 = out1000 - out250;
  if (outNext750 <= 0) return null;
  const marginalPrice = 750 / outNext750;
  const base = buy1000.basePriceUsd;
  return ((base - marginalPrice) / base) * 10000 - transactionCostBps;
}

function recommendAction(args: {
  edge250Bps: number | null;
  edge1000Bps: number | null;
  edgeNext750Bps: number | null;
  liveEligibleCount: number;
  options: TwoSizeBacktestOptions;
}): TwoSizeRecommendedAction {
  if (args.options.researchOnly || args.liveEligibleCount < args.options.minLiveSamples) {
    return "RESEARCH_ONLY";
  }
  const edge250 = args.edge250Bps ?? -Infinity;
  const edge1000 = args.edge1000Bps ?? -Infinity;
  if (edge250 < args.options.minNetEdgeBps && edge1000 < args.options.minNetEdgeBps) {
    return "DO_NOTHING";
  }
  if (
    edge1000 >= args.options.minNetEdgeBps &&
    (args.edgeNext750Bps ?? edge1000) >= args.options.minNetEdgeBps
  ) {
    return "TRADE_1000";
  }
  if (edge250 >= args.options.minNetEdgeBps) return "TRADE_250";
  return "DO_NOTHING";
}

function inc(map: Map<TwoSizeSkipReason, number>, reason: TwoSizeSkipReason): void {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}
