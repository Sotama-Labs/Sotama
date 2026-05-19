/** Tiny in-memory TTL cache with stale-while-error fallback.
 *
 *  Two age bands per entry:
 *    - **fresh**: served immediately, no recompute.
 *    - **stale**: served only when the recompute throws. Lets the dashboard
 *      survive transient DB flaps (Fly Postgres OOM-kills, host hiccups)
 *      without bubbling a 500 up to the browser. Outside the stale window
 *      the error propagates so we don't keep serving truly old data.
 *
 *  Single-process bot, no cross-instance coherence needed. */

type Entry<T> = {
  value: T;
  freshUntilMs: number;
  staleUntilMs: number;
  storedAtMs: number;
};

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  constructor(
    private readonly defaultTtlMs: number,
    /** How long a stale value remains usable when recompute fails.
     *  Defaults to 10× the fresh TTL so a brief outage (a Postgres
     *  restart that takes a couple minutes) is invisible to callers. */
    private readonly defaultStaleTtlMs: number = defaultTtlMs * 10,
  ) {
    if (defaultTtlMs <= 0) throw new Error("defaultTtlMs must be > 0");
    if (defaultStaleTtlMs < 0) throw new Error("defaultStaleTtlMs must be >= 0");
  }

  async memo(
    key: string,
    compute: () => Promise<T>,
    options: { ttlMs?: number; staleTtlMs?: number } = {},
  ): Promise<T> {
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.freshUntilMs > now) return entry.value;

    try {
      const value = await compute();
      const ttlMs = options.ttlMs ?? this.defaultTtlMs;
      const staleTtlMs = options.staleTtlMs ?? this.defaultStaleTtlMs;
      const stored: Entry<T> = {
        value,
        freshUntilMs: now + ttlMs,
        staleUntilMs: now + ttlMs + staleTtlMs,
        storedAtMs: now,
      };
      this.store.set(key, stored);
      return value;
    } catch (err) {
      if (entry && entry.staleUntilMs > now) return entry.value;
      throw err;
    }
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
