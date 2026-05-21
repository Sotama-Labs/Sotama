import { loadConfig } from "./config";
import { PythStream, type PythTickEvent } from "./pyth-stream";
import { PythSnapshotClient } from "./pyth-snapshot";
import { JupiterClient } from "./jupiter-client";
import { QuoteScheduler, type SchedulerPair } from "./quote-scheduler";
import { PairLoader } from "./pair-loader";
import { Heartbeat } from "./heartbeat";
import { SignalEngine } from "./signal-engine";
import { TradeExecutor } from "./trade-executor";
import { loadExecutorWallet } from "./wallet";
import { recordQuote, type CostBps } from "./basis-recorder";
import { createApiServer } from "./api-server";
import { SchedulerTelemetry } from "./scheduler-telemetry";
import { isExecutableTimeRegime, timeRegimeFor } from "./market-hours";
import { closePool } from "@sotama/db";
import {
  assertQuoteRpsBudget,
  buildQuoteQualityThresholds,
  classifyQuoteQuality,
  observationQualityFromStatus,
  normalizeActiveQuoteSizes,
  uiToAtomic,
} from "@sotama/market-core";
import type { PairConfig, QuoteQualityThresholds } from "@sotama/market-core";

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

function decimalsVerified(pair: PairConfig): boolean {
  return Number.isInteger(pair.tokenized.decimals) &&
    pair.tokenized.decimals >= 0 &&
    pair.tokenized.decimals <= 18 &&
    pair.quote.decimals === 6;
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
  const defaultQualityThresholds: QuoteQualityThresholds = {
    maxPythFreshnessLagMs: cfg.PYTH_MAX_FRESHNESS_LAG_MS,
    maxQuoteLatencyMs: cfg.QUALITY_MAX_QUOTE_LATENCY_MS,
    maxBasisAgeMs: cfg.QUALITY_MAX_BASIS_AGE_MS,
    maxPriceImpactBps: cfg.QUALITY_MAX_PRICE_IMPACT_BPS,
    maxPythConfidenceBps: cfg.QUALITY_MAX_PYTH_CONFIDENCE_BPS,
    allowedRouters: cfg.QUALITY_ALLOWED_ROUTERS,
    allowedMarketSessions: [
      "US_EQUITY_REGULAR",
      "METAL_ACTIVE",
      "CRYPTO_NORMAL",
      "CRYPTO_HIGH_VOL",
    ],
  };

  const jup = new JupiterClient({
    baseUrl: cfg.jupiterBaseUrl,
    apiKey: cfg.JUPITER_API_KEY,
  });
  const executorWallet = await loadExecutorWallet({
    mode: cfg.TRADE_EXECUTION_MODE,
    privateKeyBase58: cfg.TRADE_EXECUTOR_PRIVATE_KEY_BS58,
    taker: cfg.TRADE_EXECUTOR_TAKER,
  });
  const tradeExecutor = new TradeExecutor(
    {
      mode: cfg.TRADE_EXECUTION_MODE,
      taker: executorWallet?.taker,
      signer: executorWallet?.signer,
      minIntervalMs: cfg.TRADE_EXECUTION_MIN_INTERVAL_MS,
      retainRaw: cfg.TRADE_EXECUTION_RETAIN_RAW,
      heliusRpcUrl: cfg.HELIUS_RPC_URL,
      heliusSenderUrl: cfg.HELIUS_SENDER_URL,
      heliusSenderTipLamports: cfg.HELIUS_SENDER_TIP_LAMPORTS,
      senderExcludeRouters: cfg.TRADE_EXECUTION_SENDER_EXCLUDE_ROUTERS,
      confirmationTimeoutMs: cfg.TRADE_EXECUTION_CONFIRMATION_TIMEOUT_MS,
    },
    jup,
  );

  const stream = new PythStream({
    accessToken: cfg.PYTH_LAZER_ACCESS_TOKEN,
    feedIds: [],
    channel: cfg.PYTH_CHANNEL,
    maxFreshnessLagMs: cfg.PYTH_MAX_FRESHNESS_LAG_MS,
  });
  const snapshots = new PythSnapshotClient({
    hermesBaseUrl: cfg.PYTH_HERMES_URL,
    lazerSymbolsUrl: cfg.PYTH_LAZER_SYMBOLS_URL,
  });

  const heartbeat = new Heartbeat();
  const schedulerTelemetry = new SchedulerTelemetry();
  const transactionCostBps =
    cfg.SLIPPAGE_BUFFER_BPS + cfg.LANDING_COST_BPS + cfg.FAILURE_BUFFER_BPS;
  const signals = new SignalEngine({
    staleAfterMs: cfg.SIGNAL_MAX_HOLD_MS,
    transactionCostBps,
    executor: tradeExecutor,
  });

  /** lazer_id -> [pair_ids consuming it]. A single Lazer feed may back several pairs. */
  const lazerIdToPairs = new Map<number, Set<string>>();
  /** pair_id -> PairConfig. Needed because the scheduler holds only its lighter view. */
  const pairConfigs = new Map<string, PairConfig>();
  /** pair_id -> prior accepted Pyth price. Used only to classify crypto high-vol regimes. */
  const lastRegimePriceByPair = new Map<string, number>();
  /** pair_id -> last true Lazer stream tick. Snapshot fallback does not update this. */
  const lastStreamTickAtByPair = new Map<string, number>();
  const lastStalePythWarnByPair = new Map<string, number>();
  const lastSnapshotWarnByPair = new Map<string, number>();
  const snapshotInFlightByPair = new Set<string>();

  const scheduler = new QuoteScheduler({
    maxRps: cfg.JUPITER_MAX_RPS,
    bucketCapacity: cfg.JUPITER_MAX_RPS,
    nowMs: () => Date.now(),
    onAdmit: (pairId) => schedulerTelemetry.recordAdmitted(pairId),
    onRpsRejection: (pairId) => schedulerTelemetry.recordDroppedRps(pairId),
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
      const thresholds = buildQuoteQualityThresholds(
        {
          ...pair.qualityGate,
          maxPythFreshnessLagMs:
            pair.qualityGate?.maxPythFreshnessLagMs ?? maxFreshnessLagMsForPair(pair),
        },
        defaultQualityThresholds,
      );
      const quoteQuality =
        result.status === "ok"
          ? classifyQuoteQuality(
              {
                pythFreshnessLagMs: work.pythFreshnessLagMs,
                quoteRequestMs: result.requestMs,
                basisAgeMs,
                priceImpactPct: result.priceImpactPct,
                pythConfidenceBps: work.pythConfidenceBps,
                router: result.router,
                timeRegime: work.timeRegime ?? null,
                decimalsVerified: decimalsVerified(pair),
              },
              thresholds,
            )
          : {
              qualityStatus: "STALE_BASIS" as const,
              qualityReason: "Jupiter quote did not return executable amounts",
            };
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
          pythConfidenceBps: work.pythConfidenceBps ?? null,
          pythMarketSession: work.pythMarketSession ?? null,
          quoteRequestStartedAt: new Date(quoteRequestStartedAtMs),
          quoteResponseAt: new Date(quoteResponseAtMs),
          quoteRequestMs: result.requestMs,
          basisAgeMs,
          quality: observationQualityFromStatus(quoteQuality.qualityStatus),
          qualityStatus: quoteQuality.qualityStatus,
          qualityReason: quoteQuality.qualityReason,
          timeRegime: work.timeRegime ?? null,
        },
        successRawSampleRate: cfg.JUPITER_SUCCESS_RAW_SAMPLE_RATE,
      });
      if (
        recorded.status === "ok" &&
        work.allowSignals !== false &&
        recorded.qualityStatus === "LIVE_ELIGIBLE"
      ) {
        await signals.onObservation({
          pair,
          side,
          sizeUsd,
          basePriceUsd: priceUsd,
          tokenPriceUsd: recorded.tokenPriceUsd,
          netEdgeBps: recorded.netBps,
          quoteId: recorded.quoteId,
          basisId: recorded.basisId,
          qualityStatus: recorded.qualityStatus,
          qualityReason: recorded.qualityReason,
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
    void queueSnapshotProbe(normalized, "pair_indexed");
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
    lastRegimePriceByPair.delete(id);
    lastStreamTickAtByPair.delete(id);
    lastSnapshotWarnByPair.delete(id);
    snapshotInFlightByPair.delete(id);
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

  type PythTickSource = "stream" | "snapshot";

  const shouldProbeSnapshot = (pair: PairConfig, nowMs: number): boolean => {
    if (pair.base.assetClass === "Crypto") return false;
    const lastStreamAt = lastStreamTickAtByPair.get(pair.id) ?? 0;
    return nowMs - lastStreamAt >= cfg.PYTH_SNAPSHOT_AFTER_SILENCE_MS;
  };

  async function queueSnapshotProbe(
    pair: PairConfig,
    reason: "pair_indexed" | "stream_silent",
  ): Promise<void> {
    if (!shouldProbeSnapshot(pair, Date.now())) return;
    if (snapshotInFlightByPair.has(pair.id)) return;
    snapshotInFlightByPair.add(pair.id);
    try {
      const tick = await snapshots.latestForPair({
        pair,
        maxFreshnessLagMs: maxFreshnessLagMsForPair(pair),
      });
      if (!tick) {
        warnSnapshot(pair.id, `[pyth] snapshot unavailable pair=${pair.id} reason=${reason}`);
        return;
      }
      processPythTick(tick, "snapshot");
    } catch (e) {
      heartbeat.countError();
      warnSnapshot(
        pair.id,
        `[pyth] snapshot failed pair=${pair.id} reason=${reason}: ${String((e as Error).message ?? e)}`,
      );
    } finally {
      snapshotInFlightByPair.delete(pair.id);
    }
  }

  function warnSnapshot(pairId: string, message: string): void {
    const nowMs = Date.now();
    const lastWarnAt = lastSnapshotWarnByPair.get(pairId) ?? 0;
    if (nowMs - lastWarnAt < 60_000) return;
    lastSnapshotWarnByPair.set(pairId, nowMs);
    console.warn(message);
  }

  function processPythTick(t: PythTickEvent, source: PythTickSource): void {
    const pairs = lazerIdToPairs.get(t.pythLazerId);
    if (!pairs) return;
    const nowMs = Date.now();
    if (source === "stream") {
      const lagMs = Math.max(0, nowMs - Math.floor(t.streamTimestampUs / 1000));
      heartbeat.observeStreamLag(lagMs);
    }
    for (const pairId of pairs) {
      const pair = pairConfigs.get(pairId);
      if (!pair) continue;
      if (source === "stream") lastStreamTickAtByPair.set(pairId, nowMs);
      schedulerTelemetry.recordScheduled(pairId);
      const maxFreshnessLagMs = maxFreshnessLagMsForPair(pair);
      const pythIsStale = t.freshnessLagMs > maxFreshnessLagMs;
      if (pythIsStale && source === "stream") {
        heartbeat.countInvalidFeed();
        schedulerTelemetry.recordDroppedStalePyth(pairId);
        const lastWarnAt = lastStalePythWarnByPair.get(pairId) ?? 0;
        if (nowMs - lastWarnAt >= 30_000) {
          lastStalePythWarnByPair.set(pairId, nowMs);
          console.warn(
            `[pyth] stale tick skipped pair=${pairId} feed=${t.pythLazerId} ` +
            `freshness=${t.freshnessLagMs}ms max=${maxFreshnessLagMs}ms`,
          );
        }
        continue;
      }

      const previousPrice = lastRegimePriceByPair.get(pairId);
      const cryptoMoveBps =
        previousPrice != null && previousPrice > 0
          ? Math.abs((t.priceUsd / previousPrice - 1) * 10000)
          : 0;
      lastRegimePriceByPair.set(pairId, t.priceUsd);
      const timeRegime = timeRegimeFor(pair.base.assetClass, nowMs, {
        cryptoMoveBps,
        cryptoHighVolMoveBps: cfg.CRYPTO_HIGH_VOL_MOVE_BPS,
        pythMarketSession: t.marketSession,
      });
      const executableRegime = isExecutableTimeRegime(timeRegime);
      if (!executableRegime) {
        schedulerTelemetry.recordDroppedMarketSession(pairId);
      }
      scheduler.onPriceTick(pairId, t.priceUsd, {
        streamTimestampUs: t.streamTimestampUs,
        feedUpdateTimestampUs: t.feedUpdateTimestampUs,
        pythFreshnessLagMs: t.freshnessLagMs,
        pythConfidenceBps:
          t.confidenceUsd == null || t.priceUsd <= 0
            ? null
            : (t.confidenceUsd / t.priceUsd) * 10000,
        pythMarketSession: t.marketSession,
        timeRegime,
        allowSignals: executableRegime && !pythIsStale,
      });
    }
  }

  // Layer-1 compacted storage: every Pyth tick used to be persisted to
  // `pyth_ticks` (~432k rows/day/pair on a 200 ms channel) but the price
  // is already snapshotted onto every basis_observations row at quote
  // time. Skip the raw insert and just hand the tick to the scheduler.
  stream.on((t: PythTickEvent) => {
    processPythTick(t, "stream");
  });

  stream.start();
  const stopLoader = loader.start();
  const snapshotHandle = setInterval(() => {
    const nowMs = Date.now();
    for (const pair of pairConfigs.values()) {
      if (shouldProbeSnapshot(pair, nowMs)) {
        void queueSnapshotProbe(pair, "stream_silent");
      }
    }
  }, cfg.PYTH_SNAPSHOT_POLL_INTERVAL_MS);
  const apiServer = createApiServer({
    port: cfg.API_PORT,
    corsOrigin: cfg.API_CORS_ORIGIN,
    costInputsBps: costs,
    schedulerTelemetry: () => schedulerTelemetry.snapshot(),
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
    clearInterval(snapshotHandle);
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
