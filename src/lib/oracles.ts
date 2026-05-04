"use client";

/* ─────────────────────────────────────────────────────────────────────
   Pyth Hermes — keeper-agnostic price oracle.
   Feed lookup by symbol; latest price + SSE streaming for live previews.
   Tokens without a Pyth feed save with a `switchboard_pending` marker —
   the keeper resolves Switchboard On-Demand at runtime.
   ───────────────────────────────────────────────────────────────────── */

import type { OracleSource, TokenRef } from "./types";

const HERMES =
  process.env.NEXT_PUBLIC_PYTH_HERMES_URL || "https://hermes.pyth.network";

/** Hardcoded so the SOL price hook doesn't pay a feed-lookup roundtrip on first paint. */
export const SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

type FeedAttributes = {
  asset_type?: string;
  base?: string;
  quote_currency?: string;
  symbol?: string;
  display_symbol?: string;
};

type FeedEntry = {
  id: string;
  attributes?: FeedAttributes;
};

export type PriceUpdate = {
  price: number;
  confidence: number;
  publishTime: number;
};

export function normalizeFeedId(id: string): string {
  return id.startsWith("0x") ? id.slice(2) : id;
}

/** Search Pyth's feed registry for a USD-quoted crypto feed matching `symbol`. */
export async function lookupPythFeed(
  symbol: string,
): Promise<{ feedId: string; symbol: string } | null> {
  const query = encodeURIComponent(symbol);
  const url = `${HERMES}/v2/price_feeds?query=${query}&asset_type=crypto`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const feeds = (await res.json()) as FeedEntry[];
    if (!Array.isArray(feeds)) return null;

    const upper = symbol.toUpperCase();
    const exact = feeds.find(
      (f) =>
        f.attributes?.base?.toUpperCase() === upper &&
        f.attributes?.quote_currency?.toUpperCase() === "USD",
    );
    if (exact) {
      return {
        feedId: normalizeFeedId(exact.id),
        symbol: exact.attributes?.symbol || `Crypto.${upper}/USD`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Build the OracleSource for a given token, falling back to switchboard_pending. */
export async function resolveOracleForToken(token: TokenRef): Promise<OracleSource> {
  const found = await lookupPythFeed(token.symbol);
  if (found) {
    return { kind: "pyth", feedId: found.feedId, symbol: found.symbol };
  }
  return { kind: "switchboard_pending", symbol: token.symbol };
}

type ParsedPrice = {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
};

type LatestResponse = { parsed?: ParsedPrice[] };

function parsedToUpdate(p: ParsedPrice | undefined): PriceUpdate | null {
  if (!p) return null;
  const expo = p.price.expo;
  const scale = Math.pow(10, expo);
  return {
    price: Number(p.price.price) * scale,
    confidence: Number(p.price.conf) * scale,
    publishTime: p.price.publish_time * 1000,
  };
}

export async function fetchPythLatest(feedId: string): Promise<PriceUpdate | null> {
  const id = normalizeFeedId(feedId);
  const url = `${HERMES}/v2/updates/price/latest?ids[]=${id}&parsed=true`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const json = (await res.json()) as LatestResponse;
    return parsedToUpdate(json.parsed?.[0]);
  } catch {
    return null;
  }
}

export type StreamHandle = { close: () => void };

/** SSE subscription with a polling fallback used by usePythPrice. */
export function subscribePythStream(
  feedId: string,
  onUpdate: (u: PriceUpdate) => void,
  onModeChange?: (mode: "live" | "polling" | "error") => void,
): StreamHandle {
  const id = normalizeFeedId(feedId);
  const streamUrl = `${HERMES}/v2/updates/price/stream?ids[]=${id}&parsed=true&allow_unordered=true&benchmarks_only=false`;

  let alive = true;
  let es: EventSource | null = null;
  let poll: number | null = null;

  const stopPoll = () => {
    if (poll != null) {
      window.clearInterval(poll);
      poll = null;
    }
  };

  const startPoll = async () => {
    onModeChange?.("polling");
    const tick = async () => {
      if (!alive) return;
      const u = await fetchPythLatest(id);
      if (u && alive) onUpdate(u);
    };
    await tick();
    poll = window.setInterval(tick, 5000);
  };

  try {
    es = new EventSource(streamUrl);
    onModeChange?.("live");
    es.onmessage = (ev) => {
      try {
        const json = JSON.parse(ev.data) as LatestResponse;
        const u = parsedToUpdate(json.parsed?.[0]);
        if (u && alive) onUpdate(u);
      } catch {
        // ignore malformed frames
      }
    };
    es.onerror = () => {
      es?.close();
      es = null;
      if (!alive) return;
      startPoll();
    };
  } catch {
    startPoll();
  }

  return {
    close: () => {
      alive = false;
      es?.close();
      stopPoll();
    },
  };
}
