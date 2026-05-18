import { listEnabledPairs } from "@sotama/db";
import type { PairConfig } from "@sotama/market-core";

export type PairLoaderHandlers = {
  onAdded: (p: PairConfig) => void;
  onRemoved: (id: string) => void;
  onUpdated: (p: PairConfig) => void;
};

/** Periodically polls the DB for enabled pairs and diffs against the in-memory set.
 *  The bot subscribes to add/remove/update events to reconfigure its workers
 *  without restarting. */
export class PairLoader {
  private current = new Map<string, PairConfig>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: { intervalMs: number } & PairLoaderHandlers,
  ) {}

  async refresh(): Promise<void> {
    const next = await listEnabledPairs();
    const nextById = new Map(next.map((p) => [p.id, p]));

    for (const [id] of this.current) {
      if (!nextById.has(id)) this.cfg.onRemoved(id);
    }
    for (const p of next) {
      const prev = this.current.get(p.id);
      if (!prev) this.cfg.onAdded(p);
      else if (JSON.stringify(prev) !== JSON.stringify(p)) this.cfg.onUpdated(p);
    }
    this.current = nextById;
  }

  start(): () => void {
    const tick = () => {
      this.refresh().catch((e) => console.error("pair refresh failed", e));
    };
    tick();
    this.timer = setInterval(tick, this.cfg.intervalMs);
    return () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    };
  }
}
