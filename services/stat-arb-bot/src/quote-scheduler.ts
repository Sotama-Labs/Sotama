import { TokenBucket } from "@sotama/market-core";
import type { PairDirection, TimeRegime } from "@sotama/market-core";

export type SchedulerPair = {
  pairId: string;
  lastPriceUsd: number;
  sides: PairDirection[];
  sizesUsd: number[];
  quoteIntervalMs: number;
  minPriceMoveBps: number;
};

export type WorkId = string; // "pairId|side|sizeUsd"

export type PriceTickMetadata = {
  streamTimestampUs: number;
  feedUpdateTimestampUs: number;
  pythFreshnessLagMs: number;
  pythConfidenceBps?: number | null;
  pythMarketSession?: string | null;
  timeRegime?: TimeRegime | null;
  allowSignals?: boolean;
};

export type WorkContext = PriceTickMetadata & {
  workId: WorkId;
  queuedAtMs: number;
};

export type SchedulerOnWork = (
  workId: WorkId,
  pair: SchedulerPair,
  side: PairDirection,
  sizeUsd: number,
  priceUsd: number,
  context: WorkContext,
) => void | Promise<void>;

export type SchedulerOnAdmit = (
  pairId: string,
  side: PairDirection,
  sizeUsd: number,
) => void;

export type SchedulerOnRpsRejection = (
  pairId: string,
  side: PairDirection,
  sizeUsd: number,
) => void;

/** Owns the global Jupiter RPS budget. On every Pyth tick for a tracked pair,
 *  evaluates each (side, size) combination: has that route's cooldown elapsed,
 *  and does it fit under the shared RPS budget. The per-route cooldown is a
 *  hard guardrail; Jupiter dashboards count bursty price-move probes the same
 *  as ordinary probes. */
export class QuoteScheduler {
  private readonly bucket: TokenBucket;
  private readonly pairs = new Map<string, SchedulerPair>();
  private readonly lastQuoteAt = new Map<WorkId, number>();
  private readonly lastQuotedPrice = new Map<WorkId, number>();

  constructor(
    private readonly cfg: {
      maxRps: number;
      bucketCapacity: number;
      nowMs: () => number;
      onWork: SchedulerOnWork;
      onError?: (error: unknown, context: WorkContext) => void;
      /** Called once per (side, size) quote actually admitted into the
       *  Jupiter budget — i.e. the bot will issue an HTTP request. */
      onAdmit?: SchedulerOnAdmit;
      /** Called when a (side, size) would have quoted but the global RPS
       *  bucket was empty. Other reasons (interval-not-elapsed, no price
       *  move) are deliberately silent — they are normal scheduler hygiene,
       *  not capacity pressure. */
      onRpsRejection?: SchedulerOnRpsRejection;
    },
  ) {
    this.bucket = new TokenBucket({
      capacity: cfg.bucketCapacity,
      refillPerSec: cfg.maxRps,
      nowMs: cfg.nowMs,
    });
  }

  upsertPair(p: SchedulerPair): void {
    this.pairs.set(p.pairId, p);
  }

  removePair(pairId: string): void {
    this.pairs.delete(pairId);
    for (const k of [...this.lastQuoteAt.keys()]) {
      if (k.startsWith(`${pairId}|`)) {
        this.lastQuoteAt.delete(k);
        this.lastQuotedPrice.delete(k);
      }
    }
  }

  get activePairCount(): number {
    return this.pairs.size;
  }

  get budgetAvailable(): number {
    return this.bucket.available;
  }

  onPriceTick(
    pairId: string,
    priceUsd: number,
    meta: PriceTickMetadata = {
      streamTimestampUs: 0,
      feedUpdateTimestampUs: 0,
      pythFreshnessLagMs: 0,
      pythConfidenceBps: null,
      pythMarketSession: null,
    },
  ): void {
    const p = this.pairs.get(pairId);
    if (!p) return;
    p.lastPriceUsd = priceUsd;
    for (const side of p.sides) {
      for (const size of p.sizesUsd) {
        const id: WorkId = `${pairId}|${side}|${size}`;
        if (!this.shouldQuote(id, p)) continue;
        if (!this.bucket.tryTake()) {
          this.cfg.onRpsRejection?.(pairId, side, size);
          continue;
        }
        this.cfg.onAdmit?.(pairId, side, size);
        const queuedAtMs = this.cfg.nowMs();
        this.lastQuoteAt.set(id, queuedAtMs);
        this.lastQuotedPrice.set(id, priceUsd);
        const context: WorkContext = { workId: id, queuedAtMs, ...meta };
        void Promise.resolve(
          this.cfg.onWork(id, p, side, size, priceUsd, context),
        ).catch((error) => {
          this.cfg.onError?.(error, context);
        });
      }
    }
  }

  private shouldQuote(id: WorkId, p: SchedulerPair): boolean {
    const lastAt = this.lastQuoteAt.get(id) ?? -Infinity;
    const lastPx = this.lastQuotedPrice.get(id);
    const elapsed = this.cfg.nowMs() - lastAt;
    if (lastPx == null || lastPx <= 0) return true;
    if (elapsed < p.quoteIntervalMs) return false;
    return true;
  }
}
