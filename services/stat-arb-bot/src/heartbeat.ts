import { recordHeartbeat } from "@sotama/db";

/** Tracks counters in a rolling 60s window. The bot's main loop calls `tick()`
 *  every HEARTBEAT_INTERVAL_MS — typically 5s. */
export class Heartbeat {
  private http429 = 0;
  private errors = 0;
  private windowStartMs = Date.now();
  private lastStreamLagMs: number | null = null;
  private lastQuoteLagMs: number | null = null;

  countHttp429(): void {
    this.http429 += 1;
  }
  countError(): void {
    this.errors += 1;
  }
  observeStreamLag(lagMs: number): void {
    this.lastStreamLagMs = lagMs;
  }
  observeQuoteLag(lagMs: number): void {
    this.lastQuoteLagMs = lagMs;
  }

  async tick(args: { activePairs: number; currentRps: number }): Promise<void> {
    const now = Date.now();
    if (now - this.windowStartMs >= 60_000) {
      this.http429 = 0;
      this.errors = 0;
      this.windowStartMs = now;
    }
    await recordHeartbeat({
      streamLagMs: this.lastStreamLagMs,
      quoteLagMs: this.lastQuoteLagMs,
      activePairCount: args.activePairs,
      currentRps: args.currentRps,
      http429Count1m: this.http429,
      errorCount1m: this.errors,
    });
  }
}
