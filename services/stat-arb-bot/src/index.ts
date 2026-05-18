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
import { uiToAtomic } from "@sotama/market-core";
import type { PairConfig } from "@sotama/market-core";

const STALE_SIGNAL_MS = 30 * 60_000;

function toSchedulerPair(p: PairConfig, lastPriceUsd: number = 0): SchedulerPair {
  return {
    pairId: p.id,
    lastPriceUsd,
    sides: p.directions,
    sizesUsd: p.sizesUsd,
    quoteIntervalMs: p.quoteIntervalMs,
    minPriceMoveBps: p.minPriceMoveBps,
  };
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
  });

  const heartbeat = new Heartbeat();
  const signals = new SignalEngine({ staleAfterMs: STALE_SIGNAL_MS });

  /** lazer_id -> [pair_ids consuming it]. A single Lazer feed may back several pairs. */
  const lazerIdToPairs = new Map<number, Set<string>>();
  /** pair_id -> PairConfig. Needed because the scheduler holds only its lighter view. */
  const pairConfigs = new Map<string, PairConfig>();

  const scheduler = new QuoteScheduler({
    maxRps: cfg.JUPITER_MAX_RPS,
    bucketCapacity: cfg.JUPITER_MAX_RPS,
    nowMs: () => Date.now(),
    onWork: async (_id, schedPair, side, sizeUsd, priceUsd) => {
      const pair = pairConfigs.get(schedPair.pairId);
      if (!pair) return;
      const inputMint = side === "buy_tokenized" ? pair.quote.mint : pair.tokenized.mint;
      const outputMint = side === "buy_tokenized" ? pair.tokenized.mint : pair.quote.mint;
      const amount = inputAtomicForOrder(pair, side, sizeUsd, priceUsd);
      const result = await jup.order({
        inputMint,
        outputMint,
        amount,
        slippageBps: pair.slippageBps,
      });
      if (result.status === "rate_limited") heartbeat.countHttp429();
      else if (result.status === "error") heartbeat.countError();
      else if (result.status === "ok") heartbeat.observeQuoteLag(result.requestMs);

      const recorded = await recordQuote({
        pair,
        side,
        sizeUsd,
        basePriceUsd: priceUsd,
        result,
        costsBps: costs,
      });
      if (recorded.status === "ok") {
        await signals.onObservation({
          pair,
          side,
          sizeUsd,
          netEdgeBps: recorded.netBps,
          nowMs: Date.now(),
        });
      }
    },
  });

  const indexPair = (p: PairConfig) => {
    pairConfigs.set(p.id, p);
    const set = lazerIdToPairs.get(p.base.pythLazerId) ?? new Set<string>();
    set.add(p.id);
    lazerIdToPairs.set(p.base.pythLazerId, set);
    scheduler.upsertPair(toSchedulerPair(p));
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
  const refreshSubscriptions = () => {
    stream.setFeedIds([...lazerIdToPairs.keys()]);
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
    const lagMs = Math.max(0, Date.now() - Math.floor(t.publishTimeUs / 1000));
    heartbeat.observeStreamLag(lagMs);
    const nowMs = Date.now();
    for (const pairId of pairs) {
      const pair = pairConfigs.get(pairId);
      // Skip after-hours equity ticks so we don't burn Jupiter RPS on
      // markets that aren't trading. Other asset classes (Crypto, Metal,
      // FX, Commodity) are always considered open.
      if (pair && !isMarketOpen(pair.base.assetClass, nowMs)) continue;
      scheduler.onPriceTick(pairId, t.priceUsd);
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
