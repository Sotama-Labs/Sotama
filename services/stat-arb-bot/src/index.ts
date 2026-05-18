import { loadConfig } from "./config";
import { PythStream, type PythTickEvent } from "./pyth-stream";
import { JupiterClient } from "./jupiter-client";
import { QuoteScheduler, type SchedulerPair } from "./quote-scheduler";
import { PairLoader } from "./pair-loader";
import { Heartbeat } from "./heartbeat";
import { SignalEngine } from "./signal-engine";
import { recordQuote, type CostBps } from "./basis-recorder";
import { createApiServer } from "./api-server";
import { isMarketOpen } from "./market-hours";
import { closePool } from "@sotama/db";
import {
  assertQuoteRpsBudget,
  normalizeActiveQuoteSizes,
  uiToAtomic,
} from "@sotama/market-core";
import type { PairConfig } from "@sotama/market-core";

const STALE_SIGNAL_MS = 30 * 60_000;

function toSchedulerPair(p: PairConfig, lastPriceUsd: number = 0): SchedulerPair {
  return {
    pairId: p.id,
    lastPriceUsd,
    sides: p.directions,
    sizesUsd: normalizeActiveQuoteSizes(p.sizesUsd),
    quoteIntervalMs: p.quoteIntervalMs,
    minPriceMoveBps: p.minPriceMoveBps,
  };
}

function maxFreshnessLagMsForPair(pair: PairConfig): number {
  if (pair.base.maxPythFreshnessLagMs != null) return pair.base.maxPythFreshnessLagMs;
  switch (pair.base.assetClass) {
    case "Crypto":
      return 2_500;
    case "Equity":
      return 10_000;
    case "FX":
    case "Metal":
    case "Commodity":
      return 15_000;
    default:
      return 5_000;
  }
}

function runtimePair(p: PairConfig): PairConfig | null {
  const sizesUsd = normalizeActiveQuoteSizes(p.sizesUsd);
  if (sizesUsd.length === 0) return null;
  return { ...p, sizesUsd: sizesUsd as PairConfig["sizesUsd"] };
}

function assertRuntimeBudget(pairs: Iterable<PairConfig>, maxRps: number): void {
  assertQuoteRpsBudget({
    pairs: [...pairs],
    maxRps,
    headroom: 0.85,
  });
}

function inputAtomicForOrder(
  pair: PairConfig,
  side: "buy_tokenized" | "sell_tokenized",
  sizeUsd: number,
  priceUsd: number,
): bigint {
  if (side === "buy_tokenized") {
    return uiToAtomic(sizeUsd, pair.quote.decimals);
  }
  // sell: input is tokenized; size_usd / price_usd = units of tokenized
  if (priceUsd <= 0) throw new Error("priceUsd must be > 0");
  return uiToAtomic(sizeUsd / priceUsd, pair.tokenized.decimals);
}

async function main() {
  const cfg = loadConfig();

  const costs: CostBps = {
    slippageBufferBps: cfg.SLIPPAGE_BUFFER_BPS,
    landingCostBps: cfg.LANDING_COST_BPS,
    failureBufferBps: cfg.FAILURE_BUFFER_BPS,
    minProfitBps: cfg.MIN_PROFIT_BPS,
  };

  const jup = new JupiterClient({
    baseUrl: cfg.jupiterBaseUrl,
    apiKey: cfg.JUPITER_API_KEY,
  });

  const stream = new PythStream({
    accessToken: cfg.PYTH_LAZER_ACCESS_TOKEN,
    feedIds: [],
    channel: cfg.PYTH_CHANNEL,
    maxFreshnessLagMs: cfg.PYTH_MAX_FRESHNESS_LAG_MS,
  });

  const heartbeat = new Heartbeat();
  const transactionCostBps =
    cfg.SLIPPAGE_BUFFER_BPS + cfg.LANDING_COST_BPS + cfg.FAILURE_BUFFER_BPS;
  const signals = new SignalEngine({
    staleAfterMs: STALE_SIGNAL_MS,
    transactionCostBps,
  });

  /** lazer_id -> [pair_ids consuming it]. A single Lazer feed may back several pairs. */
  const lazerIdToPairs = new Map<number, Set<string>>();
  /** pair_id -> PairConfig. Needed because the scheduler holds only its lighter view. */
  const pairConfigs = new Map<string, PairConfig>();

  const scheduler = new QuoteScheduler({
    maxRps: cfg.JUPITER_MAX_RPS,
    bucketCapacity: cfg.JUPITER_MAX_RPS,
    nowMs: () => Date.now(),
    onWork: async (_id, schedPair, side, sizeUsd, priceUsd, work) => {
      const pair = pairConfigs.get(schedPair.pairId);
      if (!pair) return;
      const inputMint = side === "buy_tokenized" ? pair.quote.mint : pair.tokenized.mint;
      const outputMint = side === "buy_tokenized" ? pair.tokenized.mint : pair.quote.mint;
      const amount = inputAtomicForOrder(pair, side, sizeUsd, priceUsd);
      const quoteRequestStartedAtMs = Date.now();
      const result = await jup.order({
        inputMint,
        outputMint,
        amount,
        slippageBps: pair.slippageBps,
      });
      const quoteResponseAtMs = Date.now();
      if (result.status === "rate_limited") heartbeat.countHttp429();
      else if (result.status === "error") heartbeat.countError();
      else if (result.status === "ok") heartbeat.observeQuoteLag(result.requestMs);

      const basisAgeMs =
        work.streamTimestampUs > 0
          ? Math.max(0, quoteResponseAtMs - Math.floor(work.streamTimestampUs / 1000))
          : Math.max(0, quoteResponseAtMs - work.queuedAtMs);
      const recorded = await recordQuote({
        pair,
        side,
        sizeUsd,
        basePriceUsd: priceUsd,
        result,
        costsBps: costs,
        timing: {
          pythStreamTimestampUs: work.streamTimestampUs,
          pythFeedUpdateTimestampUs: work.feedUpdateTimestampUs,
          pythFreshnessLagMs: work.pythFreshnessLagMs,
          quoteRequestStartedAt: new Date(quoteRequestStartedAtMs),
          quoteResponseAt: new Date(quoteResponseAtMs),
          quoteRequestMs: result.requestMs,
          basisAgeMs,
          quality: "live",
        },
        successRawSampleRate: cfg.JUPITER_SUCCESS_RAW_SAMPLE_RATE,
      });
      if (recorded.status === "ok") {
        await signals.onObservation({
          pair,
          side,
          sizeUsd,
          basePriceUsd: priceUsd,
          tokenPriceUsd: recorded.tokenPriceUsd,
          netEdgeBps: recorded.netBps,
          quoteId: recorded.quoteId,
          basisId: recorded.basisId,
          observedAtMs: quoteResponseAtMs,
          nowMs: Date.now(),
        });
      }
    },
    onError: (error, context) => {
      heartbeat.countError();
      console.error(`[scheduler] work failed id=${context.workId}`, error);
    },
  });

  const indexPair = (p: PairConfig) => {
    const normalized = runtimePair(p);
    if (!normalized) {
      console.warn(
        `[pairs] ${p.id} has no active quote size from [250,1000]; disabling runtime scheduling`,
      );
      unindexPair(p.id);
      return;
    }

    const previous = pairConfigs.get(normalized.id);
    const candidate = new Map(pairConfigs);
    candidate.set(normalized.id, normalized);
    try {
      assertRuntimeBudget(candidate.values(), cfg.JUPITER_MAX_RPS);
    } catch (e) {
      heartbeat.countError();
      console.error(`[pairs] rejecting ${normalized.id}: ${String((e as Error).message ?? e)}`);
      if (!previous) return;
      return;
    }

    if (previous && previous.base.pythLazerId !== normalized.base.pythLazerId) {
      const oldSet = lazerIdToPairs.get(previous.base.pythLazerId);
      oldSet?.delete(normalized.id);
      if (oldSet?.size === 0) lazerIdToPairs.delete(previous.base.pythLazerId);
    }

    pairConfigs.set(normalized.id, normalized);
    const set = lazerIdToPairs.get(normalized.base.pythLazerId) ?? new Set<string>();
    set.add(normalized.id);
    lazerIdToPairs.set(normalized.base.pythLazerId, set);
    scheduler.upsertPair(toSchedulerPair(normalized));
  };
  const unindexPair = (id: string) => {
    const p = pairConfigs.get(id);
    if (p) {
      const set = lazerIdToPairs.get(p.base.pythLazerId);
      if (set) {
        set.delete(id);
        if (set.size === 0) lazerIdToPairs.delete(p.base.pythLazerId);
      }
    }
    pairConfigs.delete(id);
    scheduler.removePair(id);
  };
  // Debounce: the pair loader fires onAdded/onRemoved/onUpdated in a
  // tight loop when the DB changes. Each call to setFeedIds drops the WS
  // and reconnects (the only way to change Lazer's feed set), so N rapid
  // events would cause N reconnects. Collapse them to one per tick.
  let refreshScheduled = false;
  const refreshSubscriptions = () => {
    if (refreshScheduled) return;
    refreshScheduled = true;
    setImmediate(() => {
      refreshScheduled = false;
      stream.setFeedIds([...lazerIdToPairs.keys()]);
    });
  };

  const loader = new PairLoader({
    intervalMs: cfg.PAIR_REFRESH_INTERVAL_MS,
    onAdded: (p) => { indexPair(p); refreshSubscriptions(); },
    onUpdated: (p) => {
      const prev = pairConfigs.get(p.id);
      indexPair(p);
      if (!prev || prev.base.pythLazerId !== p.base.pythLazerId) refreshSubscriptions();
    },
    onRemoved: (id) => { unindexPair(id); refreshSubscriptions(); },
  });

  // Layer-1 compacted storage: every Pyth tick used to be persisted to
  // `pyth_ticks` (~432k rows/day/pair on a 200 ms channel) but the price
  // is already snapshotted onto every basis_observations row at quote
  // time. Skip the raw insert and just hand the tick to the scheduler.
  stream.on((t: PythTickEvent) => {
    const pairs = lazerIdToPairs.get(t.pythLazerId);
    if (!pairs) return;
    const lagMs = Math.max(0, Date.now() - Math.floor(t.streamTimestampUs / 1000));
    heartbeat.observeStreamLag(lagMs);
    const nowMs = Date.now();
    for (const pairId of pairs) {
      const pair = pairConfigs.get(pairId);
      // Skip after-hours equity ticks so we don't burn Jupiter RPS on
      // markets that aren't trading. Other asset classes (Crypto, Metal,
      // FX, Commodity) are always considered open.
      if (pair && !isMarketOpen(pair.base.assetClass, nowMs)) continue;
      if (!pair) continue;
      if (t.freshnessLagMs > maxFreshnessLagMsForPair(pair)) {
        heartbeat.countInvalidFeed();
        continue;
      }
      scheduler.onPriceTick(pairId, t.priceUsd, {
        streamTimestampUs: t.streamTimestampUs,
        feedUpdateTimestampUs: t.feedUpdateTimestampUs,
        pythFreshnessLagMs: t.freshnessLagMs,
      });
    }
  });

  stream.start();
  const stopLoader = loader.start();
  const apiServer = createApiServer({
    port: cfg.API_PORT,
    corsOrigin: cfg.API_CORS_ORIGIN,
  });
  console.log(`api server listening on :${cfg.API_PORT}`);
  const hbHandle = setInterval(() => {
    heartbeat.observeLazerHealth(stream.health());
    heartbeat
      .tick({
        activePairs: scheduler.activePairCount,
        currentRps: scheduler.budgetAvailable,
      })
      .catch((e) => console.error("heartbeat failed", e));
  }, cfg.HEARTBEAT_INTERVAL_MS);

  const shutdown = async (sig: string) => {
    console.log(`shutdown ${sig}`);
    stopLoader();
    clearInterval(hbHandle);
    stream.stop();
    apiServer.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
