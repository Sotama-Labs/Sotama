import type { PairConfig, PairDirection } from "@sotama/market-core";
import { openSignal, closeSignal, openSignalsByKey } from "@sotama/db";

/** V1 paper-trade lifecycle.
 *
 *  Entry: when net_edge_bps >= pair.minNetEdgeBps and no signal is open
 *  for this (pair, side, size) key.
 *
 *  Exit: when net_edge_bps <= 0 (basis closed) or the open signal has been
 *  alive longer than `staleAfterMs` (no convergence).
 *
 *  PnL is paper: size_usd * (exit_edge - entry_edge) / 10000. This treats
 *  the strategy as if we could execute at the observed basis on both legs,
 *  which is an optimistic bound. Real implementation would subtract another
 *  round-trip's worth of costs. */
export class SignalEngine {
  constructor(private readonly cfg: { staleAfterMs: number }) {}

  async onObservation(args: {
    pair: PairConfig;
    side: PairDirection;
    sizeUsd: number;
    netEdgeBps: number;
    nowMs: number;
  }): Promise<void> {
    const { pair, side, sizeUsd, netEdgeBps, nowMs } = args;
    const open = await openSignalsByKey({ pairId: pair.id, side, sizeUsd });

    if (open.length === 0 && netEdgeBps >= pair.minNetEdgeBps) {
      await openSignal({
        pairId: pair.id,
        side,
        sizeUsd,
        thresholdBps: pair.minNetEdgeBps,
        entryEdgeBps: netEdgeBps,
        entryAt: new Date(nowMs),
      });
      return;
    }

    for (const o of open) {
      const ageMs = nowMs - o.entryAt.getTime();
      const stale = ageMs >= this.cfg.staleAfterMs;
      const converged = netEdgeBps <= 0;
      if (!stale && !converged) continue;
      const pnl = (sizeUsd * (netEdgeBps - o.entryEdgeBps)) / 10000;
      const outcome =
        pnl > 0.01 ? "closed_win"
        : pnl < -0.01 ? "closed_loss"
        : stale ? "closed_stale"
        : "closed_flat";
      await closeSignal({
        id: o.id,
        exitEdgeBps: netEdgeBps,
        pnlUsd: pnl,
        outcome,
        exitAt: new Date(nowMs),
      });
    }
  }
}
