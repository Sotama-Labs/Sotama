export type ClosedSignal = {
  entryAt: number;  // ms epoch
  exitAt: number;
  pnlUsd: number;
  edgeBps: number;
};

export type ProfitabilitySummary = {
  cumulativePnlUsd: number;
  pnlUsd24h: number;
  pnlUsd7d: number;
  winRate: number;
  avgEdgeBps: number;
  avgHoldSeconds: number;
  maxDrawdownUsd: number;
  signalCount: number;
};

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function summarize(closed: ClosedSignal[], nowMs: number): ProfitabilitySummary {
  if (closed.length === 0) {
    return {
      cumulativePnlUsd: 0,
      pnlUsd24h: 0,
      pnlUsd7d: 0,
      winRate: 0,
      avgEdgeBps: 0,
      avgHoldSeconds: 0,
      maxDrawdownUsd: 0,
      signalCount: 0,
    };
  }
  const sorted = [...closed].sort((a, b) => a.exitAt - b.exitAt);
  let equity = 0;
  let runningMax = 0;
  let maxDd = 0;
  let wins = 0;
  let edgeSum = 0;
  let holdSum = 0;
  let pnl24 = 0;
  let pnl7 = 0;
  for (const t of sorted) {
    equity += t.pnlUsd;
    if (equity > runningMax) runningMax = equity;
    const dd = runningMax - equity;
    if (dd > maxDd) maxDd = dd;
    if (t.pnlUsd > 0) wins += 1;
    edgeSum += t.edgeBps;
    holdSum += (t.exitAt - t.entryAt) / 1000;
    if (nowMs - t.exitAt <= DAY_MS) pnl24 += t.pnlUsd;
    if (nowMs - t.exitAt <= WEEK_MS) pnl7 += t.pnlUsd;
  }
  return {
    cumulativePnlUsd: equity,
    pnlUsd24h: pnl24,
    pnlUsd7d: pnl7,
    winRate: wins / sorted.length,
    avgEdgeBps: edgeSum / sorted.length,
    avgHoldSeconds: holdSum / sorted.length,
    maxDrawdownUsd: maxDd,
    signalCount: sorted.length,
  };
}
