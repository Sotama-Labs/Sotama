import type { PairConfig } from "@sotama/market-core";
import type { PythTickEvent } from "./pyth-stream";

type FetchImpl = typeof fetch;

type LazerSymbolRow = {
  hermes_id?: string | null;
  pyth_lazer_id?: number | string | null;
  symbol?: string | null;
  state?: string | null;
};

type HermesParsedPrice = {
  id: string;
  price?: {
    price?: string;
    conf?: string;
    expo?: number;
    publish_time?: number;
  };
};

type HermesLatestResponse = {
  parsed?: HermesParsedPrice[];
};

const DEFAULT_HERMES_URL = "https://hermes.pyth.network";
const DEFAULT_LAZER_SYMBOLS_URL = "https://history.pyth-lazer.dourolabs.app/v1/symbols";

/** Fetches the most recent published Pyth price for feeds whose Lazer stream is
 * silent. This is for diagnostic route probing only: stale/off-session rows
 * still fail the live quality gate before any signal can be emitted. */
export class PythSnapshotClient {
  private readonly fetchImpl: FetchImpl;
  private readonly hermesBaseUrl: string;
  private readonly lazerSymbolsUrl: string;
  private symbolsPromise: Promise<LazerSymbolRow[]> | null = null;

  constructor(
    cfg: {
      hermesBaseUrl?: string;
      lazerSymbolsUrl?: string;
      fetchImpl?: FetchImpl;
    } = {},
  ) {
    this.fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as FetchImpl);
    this.hermesBaseUrl = stripTrailingSlash(cfg.hermesBaseUrl ?? DEFAULT_HERMES_URL);
    this.lazerSymbolsUrl = cfg.lazerSymbolsUrl ?? DEFAULT_LAZER_SYMBOLS_URL;
  }

  async latestForPair(args: {
    pair: PairConfig;
    nowMs?: number;
    maxFreshnessLagMs: number;
  }): Promise<PythTickEvent | null> {
    const nowMs = args.nowMs ?? Date.now();
    const hermesId = await this.hermesIdForPair(args.pair);
    if (!hermesId) return null;

    const url =
      `${this.hermesBaseUrl}/v2/updates/price/latest` +
      `?ids[]=${encodeURIComponent(normalizeHermesId(hermesId))}&parsed=true`;
    const res = await this.fetchImpl(url);
    if (!res.ok) return null;
    const json = (await res.json()) as HermesLatestResponse;
    const parsed = json.parsed?.[0];
    return parsedToTick({
      parsed,
      pythLazerId: args.pair.base.pythLazerId,
      nowMs,
      maxFreshnessLagMs: args.maxFreshnessLagMs,
    });
  }

  private async hermesIdForPair(pair: PairConfig): Promise<string | null> {
    const rows = await this.symbolRows();
    const byLazerId = rows.find(
      (row) =>
        row.hermes_id &&
        Number(row.pyth_lazer_id) === pair.base.pythLazerId,
    );
    if (byLazerId?.hermes_id) return byLazerId.hermes_id;

    const byStableSymbol = rows.find(
      (row) =>
        row.hermes_id &&
        row.symbol === pair.base.pythSymbol &&
        row.state === "stable",
    );
    return byStableSymbol?.hermes_id ?? null;
  }

  private async symbolRows(): Promise<LazerSymbolRow[]> {
    if (!this.symbolsPromise) {
      this.symbolsPromise = (async () => {
        const res = await this.fetchImpl(this.lazerSymbolsUrl);
        if (!res.ok) throw new Error(`Pyth Lazer symbols returned HTTP ${res.status}`);
        const json = (await res.json()) as unknown;
        return Array.isArray(json) ? (json as LazerSymbolRow[]) : [];
      })();
    }
    return this.symbolsPromise;
  }
}

function parsedToTick(args: {
  parsed: HermesParsedPrice | undefined;
  pythLazerId: number;
  nowMs: number;
  maxFreshnessLagMs: number;
}): PythTickEvent | null {
  const price = args.parsed?.price;
  if (!price) return null;

  const rawPrice = Number(price.price);
  const expo = Number(price.expo);
  const publishTimeSec = Number(price.publish_time);
  if (
    !Number.isFinite(rawPrice) ||
    !Number.isFinite(expo) ||
    !Number.isFinite(publishTimeSec) ||
    rawPrice === 0 ||
    publishTimeSec <= 0
  ) {
    return null;
  }

  const scale = Math.pow(10, expo);
  const priceUsd = rawPrice * scale;
  const confidenceRaw = price.conf == null ? null : Number(price.conf);
  const confidenceUsd =
    confidenceRaw == null || !Number.isFinite(confidenceRaw)
      ? null
      : confidenceRaw * scale;
  const feedUpdateTimestampUs = Math.round(publishTimeSec * 1_000_000);
  const streamTimestampUs = Math.round(args.nowMs * 1000);
  const freshnessLagMs = Math.max(0, args.nowMs - publishTimeSec * 1000);

  return {
    pythLazerId: args.pythLazerId,
    priceUsd,
    confidenceUsd,
    streamTimestampUs,
    feedUpdateTimestampUs,
    marketSession: null,
    freshnessLagMs,
    isFresh: freshnessLagMs <= args.maxFreshnessLagMs,
  };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeHermesId(id: string): string {
  return id.startsWith("0x") ? id.slice(2) : id;
}
