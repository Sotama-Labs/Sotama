/** Rolling 60s telemetry for the quote scheduler.
 *
 *  The scheduler decides, for every Pyth tick, whether each (side, size) gets
 *  a Jupiter quote. The dashboard needs to see *why* a pair is being starved:
 *  RPS budget exhaustion, stale Pyth, market-session invalid, or simply that
 *  no tick fired. The scheduler emits `onAdmit` and `onReject` events; this
 *  module aggregates them into a snapshot the API layer serves verbatim. */

import type { SchedulerTelemetryDto } from "@sotama/market-core";

export type SchedulerRejectReason =
  | "RPS_EXHAUSTED"
  | "INTERVAL_NOT_ELAPSED"
  | "PRICE_MOVE_TOO_SMALL"
  | "PAIR_UNKNOWN";

export type ExternalRejectReason = "STALE_PYTH" | "MARKET_SESSION_INVALID";

type PairCounters = {
  scheduled: number;
  admitted: number;
  droppedRps: number;
  droppedStalePyth: number;
  droppedMarketSession: number;
};

/** 60s rolling window. Older counts are dropped at every read so the API
 *  always reports activity over the last minute, which matches the bot's
 *  heartbeat semantics. */
export class SchedulerTelemetry {
  private readonly windowMs: number;
  private readonly perPair = new Map<string, PairCounters>();
  private windowStartMs: number;
  private readonly now: () => number;

  constructor(opts: { windowMs?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.windowStartMs = this.now();
  }

  recordScheduled(pairId: string): void {
    this.maybeReset();
    this.counters(pairId).scheduled += 1;
  }

  recordAdmitted(pairId: string): void {
    this.maybeReset();
    this.counters(pairId).admitted += 1;
  }

  recordDroppedRps(pairId: string): void {
    this.maybeReset();
    this.counters(pairId).droppedRps += 1;
  }

  recordDroppedStalePyth(pairId: string): void {
    this.maybeReset();
    this.counters(pairId).droppedStalePyth += 1;
  }

  recordDroppedMarketSession(pairId: string): void {
    this.maybeReset();
    this.counters(pairId).droppedMarketSession += 1;
  }

  snapshot(): SchedulerTelemetryDto {
    this.maybeReset();
    let scheduled = 0;
    let admitted = 0;
    let droppedRps = 0;
    let droppedStalePyth = 0;
    let droppedMarketSession = 0;
    const perPair: SchedulerTelemetryDto["perPair"] = [];
    for (const [pairId, c] of this.perPair) {
      scheduled += c.scheduled;
      admitted += c.admitted;
      droppedRps += c.droppedRps;
      droppedStalePyth += c.droppedStalePyth;
      droppedMarketSession += c.droppedMarketSession;
      perPair.push({
        pairId,
        scheduled: c.scheduled,
        admitted: c.admitted,
        droppedDueToRps: c.droppedRps,
        droppedDueToStalePyth: c.droppedStalePyth,
        droppedDueToMarketSession: c.droppedMarketSession,
      });
    }
    perPair.sort((a, b) => a.pairId.localeCompare(b.pairId));
    return {
      scheduledQuotes1m: scheduled,
      admittedQuotes1m: admitted,
      droppedDueToRps1m: droppedRps,
      droppedDueToStalePyth1m: droppedStalePyth,
      droppedDueToMarketSession1m: droppedMarketSession,
      perPair,
    };
  }

  private counters(pairId: string): PairCounters {
    const existing = this.perPair.get(pairId);
    if (existing) return existing;
    const created: PairCounters = {
      scheduled: 0,
      admitted: 0,
      droppedRps: 0,
      droppedStalePyth: 0,
      droppedMarketSession: 0,
    };
    this.perPair.set(pairId, created);
    return created;
  }

  private maybeReset(): void {
    const now = this.now();
    if (now - this.windowStartMs < this.windowMs) return;
    this.perPair.clear();
    this.windowStartMs = now;
  }
}
