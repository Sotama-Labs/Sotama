/** Tiny in-memory TTL cache.
 *
 *  Used to memoize handler responses so repeated browser polls don't
 *  re-run the same queries against Fly Postgres. Single-process bot, no
 *  cross-instance invalidation needed. */

type Entry<T> = { value: T; expiresAtMs: number };

export class TtlCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  constructor(private readonly defaultTtlMs: number) {
    if (defaultTtlMs <= 0) throw new Error("defaultTtlMs must be > 0");
  }

  /** Return the cached value if fresh; otherwise compute, cache, and return. */
  async memo(key: string, compute: () => Promise<T>, ttlMs?: number): Promise<T> {
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.expiresAtMs > now) return entry.value;
    const value = await compute();
    this.store.set(key, {
      value,
      expiresAtMs: now + (ttlMs ?? this.defaultTtlMs),
    });
    return value;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}
