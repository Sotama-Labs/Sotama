/** Token-bucket rate limiter. `nowMs` is injected so tests can deterministically
 *  advance time without sleeping. Used by the bot's quote scheduler to enforce
 *  a shared Jupiter RPS budget across all pairs/sides/sizes. */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  constructor(
    private readonly cfg: {
      capacity: number;
      refillPerSec: number;
      nowMs: () => number;
    },
  ) {
    if (cfg.capacity <= 0) throw new Error("capacity must be > 0");
    if (cfg.refillPerSec <= 0) throw new Error("refillPerSec must be > 0");
    this.tokens = cfg.capacity;
    this.lastRefillMs = cfg.nowMs();
  }
  tryTake(n: number = 1): boolean {
    this.refill();
    if (this.tokens + 1e-9 < n) return false;
    this.tokens -= n;
    return true;
  }
  get available(): number {
    this.refill();
    return this.tokens;
  }
  private refill(): void {
    const now = this.cfg.nowMs();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.cfg.capacity, this.tokens + elapsedSec * this.cfg.refillPerSec);
    this.lastRefillMs = now;
  }
}
