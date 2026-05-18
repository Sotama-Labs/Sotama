"use client";

/* ─────────────────────────────────────────────────────────────────────
   Oracle resolution — front-door for all price sources.

   Architecture: a registry of resolvers tries each source in order and
   the first hit wins. Each resolver is a self-contained provider that
   knows how to look up a feed for an (asset, quote) pair. Adding a new
   provider (Switchboard, Birdeye, …) is one entry in `RESOLVERS` plus a
   matching keeper-side watcher. The on-chain program is oracle-agnostic
   (`source: u8` byte tells the keeper which adapter to dispatch to).

   Current resolvers, in priority order:
     1. Pyth (Hermes catalog) — covers crypto, equity, FX, commodity, metal.
     2. Jupiter Price v3 — covers any tradable SPL mint that Pyth missed.
     3. switchboard_pending sentinel — placeholder for future Switchboard
        On-Demand integration; UI blocks deploy until the resolver lands.
   ───────────────────────────────────────────────────────────────────── */

import type { AssetClass, AssetRef, OracleSource, QuoteRef } from "./types";
import { displaySymbolFromBase, parsePythSymbol, POPULAR_ASSETS } from "./assets";
import { fetchJupiterPriceUSD } from "./jupiter";

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
  description?: string;
  generic_symbol?: string;
};

type FeedEntry = {
  id: string;
  attributes?: FeedAttributes;
};

export type PythFeedMetadata = {
  feedId: string;
  symbol: string;
  base: string | null;
  quote: string | null;
  description: string;
  assetClass: AssetClass;
};

export type PriceUpdate = {
  price: number;
  confidence: number;
  publishTime: number;
};

export function normalizeFeedId(id: string): string {
  return id.startsWith("0x") ? id.slice(2) : id;
}

function assetClassFromFeed(f: FeedEntry): AssetClass {
  switch ((f.attributes?.asset_type ?? "").toLowerCase()) {
    case "equity":
      return "Equity";
    case "commodity":
      return "Commodity";
    case "fx":
      return "FX";
    case "metal":
      return "Metal";
    case "crypto":
    default:
      return "Crypto";
  }
}

export async function lookupPythFeedMetadata(
  feedId: string,
): Promise<PythFeedMetadata | null> {
  const id = normalizeFeedId(feedId);
  const url = `${HERMES}/v2/price_feeds?ids[]=${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const feeds = (await res.json()) as FeedEntry[];
    if (!Array.isArray(feeds)) return null;
    const match = feeds.find((f) => normalizeFeedId(f.id) === id) ?? feeds[0];
    if (!match) return null;
    const symbol = match.attributes?.symbol ?? "";
    const parsed = symbol ? parsePythSymbol(symbol) : null;
    const base = feedBase(match) ?? parsed?.base ?? null;
    const quote = feedQuote(match) ?? parsed?.quote ?? null;
    return {
      feedId: id,
      symbol: symbol || `${base ?? id.slice(0, 6)}/${quote ?? "USD"}`,
      base,
      quote,
      description:
        match.attributes?.description ||
        match.attributes?.generic_symbol ||
        base ||
        id,
      assetClass: assetClassFromFeed(match),
    };
  } catch {
    return null;
  }
}

/** Maps AssetClass to the provider's internal query parameter. Update here when switching providers. */
const ASSET_CLASS_TO_QUERY_TYPE: Record<AssetClass, string> = {
  Crypto: "crypto",
  Equity: "equity",
  Commodity: "commodity",
  FX: "fx",
  Metal: "metal",
};

/** Extract base symbol from a feed entry.
 *  Hermes only populates `attributes.base` for crypto; for FX/Metal/Equity
 *  it must be derived by parsing `attributes.symbol` (e.g. "FX.EUR/USD" → "EUR"). */
function feedBase(f: FeedEntry): string | null {
  if (f.attributes?.base) return f.attributes.base;
  const sym = f.attributes?.symbol;
  if (!sym) return null;
  return parsePythSymbol(sym)?.base ?? null;
}

/** Extract quote currency from a feed entry, with the same fallback. */
function feedQuote(f: FeedEntry): string | null {
  if (f.attributes?.quote_currency) return f.attributes.quote_currency;
  const sym = f.attributes?.symbol;
  if (!sym) return null;
  return parsePythSymbol(sym)?.quote ?? null;
}

/** Search the feed registry for assets of a given class matching an optional query string. */
export async function searchFeedsByClass(
  assetClass: AssetClass,
  query: string,
): Promise<AssetRef[]> {
  const assetType = ASSET_CLASS_TO_QUERY_TYPE[assetClass];
  const q = encodeURIComponent(query.trim());
  const url = `${HERMES}/v2/price_feeds?query=${q}&asset_type=${assetType}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const feeds = (await res.json()) as FeedEntry[];
    if (!Array.isArray(feeds)) return [];
    const seen = new Set<string>();
    const out: AssetRef[] = [];
    // Group candidate feeds by ticker. Direct (X/USD) wins over
    // inverted (USD/X), and main-session wins over PRE/POST/OVERNIGHT
    // within direct. The picker is showing tickers, not feeds, so a
    // ticker only available as USD/X (e.g. SGD, JPY) still surfaces —
    // the inversion is applied later at the resolver/save layer.
    type Cand = { feed: FeedEntry; ticker: string; inverted: boolean };
    const byTicker = new Map<string, Cand>();
    for (const f of feeds) {
      const base = feedBase(f);
      const quote = feedQuote(f);
      if (!base || !quote) continue;
      const baseUpper = base.toUpperCase();
      const quoteUpper = quote.toUpperCase();
      let cand: Cand | null = null;
      if (quoteUpper === "USD") {
        cand = { feed: f, ticker: base, inverted: false };
      } else if (baseUpper === "USD") {
        cand = { feed: f, ticker: quote, inverted: true };
      }
      if (!cand) continue;
      const existing = byTicker.get(cand.ticker);
      const better = (() => {
        if (!existing) return true;
        // Prefer direct over inverted.
        if (existing.inverted && !cand.inverted) return true;
        if (!existing.inverted && cand.inverted) return false;
        // Same orientation — prefer main-session feed.
        return !isMainSessionFeed(existing.feed) && isMainSessionFeed(cand.feed);
      })();
      if (better) byTicker.set(cand.ticker, cand);
    }
    // Pre-index POPULAR_ASSETS for this class so Hermes-found tickers
    // can inherit the canonical SPL `mint`/`decimals` metadata. Without
    // this, a typed-search hit ("SOL") returns a mintless AssetRef —
    // and using that as a quote for a Jupiter-base trigger silently
    // fails resolveJupiter's `quote.asset.mint` requirement, leaving
    // the editor stuck on switchboard_pending with no live preview.
    const popular = POPULAR_ASSETS[assetClass] ?? [];
    const popularBySymbol = new Map(popular.map((p) => [p.symbol.toUpperCase(), p]));
    for (const [ticker, cand] of byTicker) {
      if (seen.has(ticker)) continue;
      seen.add(ticker);
      const popularMatch = popularBySymbol.get(ticker.toUpperCase());
      if (popularMatch) {
        out.push(popularMatch);
        continue;
      }
      // Hermes serves human-readable names in `attributes.description`
      // (e.g. "NVIDIA Corp", "Japanese Yen"). Falling back to the empty
      // string used to render "<TICKER>\n" with no second line in
      // AssetPicker; H1.
      const name = cand.feed.attributes?.description || cand.feed.attributes?.generic_symbol || "";
      out.push({
        symbol: ticker,
        displaySymbol: displaySymbolFromBase(ticker),
        name,
        assetClass,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Look up a direct feed for any base/quote pair (not necessarily USD-quoted). */
async function lookupDirectPairFeed(
  baseSymbol: string,
  quoteSymbol: string,
): Promise<{ feedId: string; symbol: string } | null> {
  const upper = baseSymbol.toUpperCase();
  const quoteUpper = quoteSymbol.toUpperCase();
  const url = `${HERMES}/v2/price_feeds?query=${encodeURIComponent(upper)}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const feeds = (await res.json()) as FeedEntry[];
    if (!Array.isArray(feeds)) return null;
    const match = feeds.find(
      (f) =>
        feedBase(f)?.toUpperCase() === upper &&
        feedQuote(f)?.toUpperCase() === quoteUpper,
    );
    if (match) {
      return {
        feedId: normalizeFeedId(match.id),
        symbol: match.attributes?.symbol ?? `${upper}/${quoteUpper}`,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Lookup a Pyth feed that quotes `base/quote` directly OR `quote/base`
 *  (which we then flag inverted). The on-chain trigger stores the
 *  whichever feed Pyth has and the comparator/threshold get flipped at
 *  save time when inverted, so the keeper sees a normal direct trigger.
 *  Used when neither side is USD — e.g. AUD/JPY, USD/SGD as base/quote
 *  pair, or BTC priced in EUR (if such a feed existed). */
async function lookupPairFeed(
  base: AssetRef,
  quote: AssetRef,
): Promise<{ feedId: string; symbol: string; inverted: boolean } | null> {
  const direct = await lookupDirectPairFeed(base.displaySymbol, quote.displaySymbol);
  if (direct) return { feedId: direct.feedId, symbol: direct.symbol, inverted: false };
  const inverted = await lookupDirectPairFeed(quote.displaySymbol, base.displaySymbol);
  if (inverted) return { feedId: inverted.feedId, symbol: inverted.symbol, inverted: true };
  return null;
}


/** Equity feeds come in multiple session variants per ticker:
 *    Equity.US.NVDA/USD       — regular hours (09:30–16:00 ET)
 *    Equity.US.NVDA/USD.PRE   — pre-market   (04:00–09:30 ET)
 *    Equity.US.NVDA/USD.POST  — after-hours  (16:00–20:00 ET)
 *    Equity.US.NVDA/USD.ON    — overnight    (20:00–04:00 ET)
 *  The main session feed is the one with no suffix after `/USD`. We
 *  always prefer it so threshold previews and presets reflect the
 *  canonical price; off-hours variants are last-resort fallbacks. */
function isMainSessionFeed(f: FeedEntry): boolean {
  const sym = f.attributes?.symbol ?? "";
  return sym.endsWith("/USD");
}

/** Look up the USD-quoted feed for an asset.
 *
 *  Two passes against Hermes:
 *    1. Direct: `<asset>/USD` — the conventional X/USD pair.
 *    2. Inverted: `USD/<asset>` — Pyth's preference for many minor
 *       currencies (USD/SGD, USD/JPY, USD/HKD, …). Returns `inverted=true`
 *       so callers can flip semantics (live price = 1/raw, comparator
 *       and threshold also flip at deploy time).
 *
 *  Inverted feeds compose end-to-end without any keeper-side change:
 *  the on-chain trigger ends up with comparator/threshold targeting
 *  the inverted pair, which is exactly what the keeper sees streaming. */
export async function lookupFeedForAsset(
  asset: AssetRef,
): Promise<{ feedId: string; symbol: string; inverted: boolean } | null> {
  const assetType = ASSET_CLASS_TO_QUERY_TYPE[asset.assetClass];
  const q = encodeURIComponent(asset.displaySymbol);
  const url = `${HERMES}/v2/price_feeds?query=${q}&asset_type=${assetType}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const feeds = (await res.json()) as FeedEntry[];
    if (!Array.isArray(feeds)) return null;
    const symbolUpper = asset.symbol.toUpperCase();
    const displayUpper = asset.displaySymbol.toUpperCase();

    const directCandidates = feeds.filter((f) => {
      const base = feedBase(f)?.toUpperCase();
      const quote = feedQuote(f)?.toUpperCase();
      return (base === symbolUpper || base === displayUpper) && quote === "USD";
    });
    // Prefer the main-session feed (e.g. "Equity.US.NVDA/USD") over
    // PRE/POST/OVERNIGHT variants. Without this, picker-side resolution
    // could land on a session that publishes nothing during the current
    // wall-clock time and the live preview stays empty forever.
    const direct = directCandidates.find(isMainSessionFeed) ?? directCandidates[0];
    if (direct) {
      return {
        feedId: normalizeFeedId(direct.id),
        symbol: direct.attributes?.symbol ?? `${feedBase(direct) ?? asset.symbol}/USD`,
        inverted: false,
      };
    }

    // Inverted fallback: Pyth quotes some FX as USD/X (e.g. USD/SGD,
    // USD/JPY, USD/HKD). Find an exact USD/<asset> match and flag it.
    const invertedCandidates = feeds.filter((f) => {
      const base = feedBase(f)?.toUpperCase();
      const quote = feedQuote(f)?.toUpperCase();
      return base === "USD" && (quote === symbolUpper || quote === displayUpper);
    });
    const inverted = invertedCandidates[0];
    if (inverted) {
      return {
        feedId: normalizeFeedId(inverted.id),
        symbol: inverted.attributes?.symbol ?? `USD/${feedQuote(inverted) ?? asset.symbol}`,
        inverted: true,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** A single price-oracle provider that can resolve an asset+quote pair.
 *  Returns `null` to mean "this provider doesn't have it; try the next."
 *  Adding a new provider (Switchboard, Birdeye, …) is implementing this
 *  interface and registering an entry in `RESOLVERS` below. */
type OracleResolver = (
  asset: AssetRef,
  quote: QuoteRef,
) => Promise<OracleSource | null>;

/** Pyth resolver. Three modes:
 *    1. quote = USD: look up `<base>/USD` (direct) or `USD/<base>`
 *       (inverted fallback for SGD, JPY, HKD, …).
 *    2. quote = AssetRef + base is USD: look up `USD/<quote>` (direct)
 *       or `<quote>/USD` (inverted) — handles "USD strength against X".
 *    3. quote = AssetRef + base is non-USD: try direct/inverted pair
 *       feed first (e.g. AUD/JPY, EUR/SGD). If none, fall back to a
 *       base/USD feed — `mapTriggerToIx` will route it through the
 *       Jupiter `quote_mint` path when the quote asset has a Solana
 *       mint, and the editor displays a live inferred ratio
 *       (base/USD ÷ quote/USD) for preview.
 *  Self-pairs (BTC/BTC, USD/USD) and USD/USD are rejected — meaningless. */
const resolvePyth: OracleResolver = async (asset, quote) => {
  if (quote.kind === "usd") {
    if (asset.symbol === "USD") return null; // USD/USD: meaningless
    const found = await lookupFeedForAsset(asset);
    return found
      ? {
          kind: "pyth",
          feedId: found.feedId,
          symbol: found.symbol,
          inverted: found.inverted,
        }
      : null;
  }
  // Both base and quote are concrete AssetRefs.
  if (asset.symbol === quote.asset.symbol) return null; // self-pair
  const pair = await lookupPairFeed(asset, quote.asset);
  if (pair) {
    return {
      kind: "pyth",
      feedId: pair.feedId,
      symbol: pair.symbol,
      inverted: pair.inverted,
    };
  }
  // Inferred fallback: Pyth doesn't carry the pair, so we resolve the
  // base via its USD feed. The editor shows base/USD ÷ quote/USD as a
  // live preview, and mapTriggerToIx encodes the quote leg via
  // `quote_mint` when the quote asset has a Solana mint.
  const baseUsd = await lookupFeedForAsset(asset);
  return baseUsd
    ? {
        kind: "pyth",
        feedId: baseUsd.feedId,
        symbol: baseUsd.symbol,
        inverted: baseUsd.inverted,
      }
    : null;
};

/** Jupiter resolver: USD-denominated prices for any tradable SPL mint.
 *
 *  USD quote: returns a direct Jupiter price for the base mint.
 *
 *  Non-USD quote: accepted when the quote leg has SOMETHING the keeper
 *  can convert to a USD price:
 *   • SPL mint → keeper probes Jupiter `/price/v3` for that mint.
 *   • Pyth feed (Equity / FX / Metal / Commodity / non-Solana Crypto)
 *     → keeper polls Hermes/Lazer for that feed.
 *  Either way, the on-chain trigger stores 32 bytes in `quote_mint` and
 *  the keeper disambiguates at fire time by checking against its cached
 *  Pyth symbol catalog (catalog hit → Pyth path; miss → Jupiter probe). */
const resolveJupiter: OracleResolver = async (asset, quote) => {
  if (!asset.mint) return null;
  if (quote.kind === "asset" && !quote.asset.mint) {
    const quotePyth = await lookupFeedForAsset(quote.asset);
    if (!quotePyth) return null;
  }
  const price = await fetchJupiterPriceUSD(asset.mint);
  if (!price) return null;
  const quoteSym = quote.kind === "usd" ? "USD" : quote.asset.displaySymbol;
  return { kind: "jupiter", mint: asset.mint, symbol: `${asset.displaySymbol}/${quoteSym}` };
};

/** Registry of available oracle providers, in priority order. The first
 *  resolver that returns non-null wins. To add a provider: append a new
 *  resolver here and a matching keeper watcher in `keeper/src/`. */
const RESOLVERS: ReadonlyArray<OracleResolver> = [resolvePyth, resolveJupiter];

/** Resolve an OracleSource for an asset/quote pair.
 *  Tries each provider in `RESOLVERS` in order; first hit wins. Falls
 *  back to `switchboard_pending` only when nothing matches — UI blocks
 *  deploy on that sentinel until a Switchboard resolver lands. */
export async function resolveOracleForPair(
  asset: AssetRef,
  quote: QuoteRef,
): Promise<OracleSource> {
  for (const resolver of RESOLVERS) {
    const hit = await resolver(asset, quote);
    if (hit) return hit;
  }
  return { kind: "switchboard_pending", symbol: asset.symbol };
}

/** Fetch the live pair price for an asset/quote combination.
 *  Returns the price and whether it came from a direct pair feed.
 *  For inferred pairs: fetches base/USD and quote/USD and divides. */
export async function fetchPairPrice(
  asset: AssetRef,
  quote: QuoteRef,
): Promise<{ price: number; direct: boolean } | null> {
  if (quote.kind === "usd") {
    const found = await lookupFeedForAsset(asset);
    if (!found) return null;
    const p = await fetchPythLatest(found.feedId);
    if (!p) return null;
    return { price: p.price, direct: true };
  }
  // Try direct pair
  const direct = await lookupDirectPairFeed(asset.symbol, quote.asset.symbol);
  if (direct) {
    const p = await fetchPythLatest(direct.feedId);
    if (p) return { price: p.price, direct: true };
  }
  // Infer via base/USD ÷ quote/USD
  const [baseFound, quoteFound] = await Promise.all([
    lookupFeedForAsset(asset),
    lookupFeedForAsset(quote.asset),
  ]);
  if (!baseFound || !quoteFound) return null;
  const [baseP, quoteP] = await Promise.all([
    fetchPythLatest(baseFound.feedId),
    fetchPythLatest(quoteFound.feedId),
  ]);
  if (!baseP || !quoteP || quoteP.price === 0) return null;
  return { price: baseP.price / quoteP.price, direct: false };
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

/** SSE subscription with a polling fallback used by usePythPrice.
 *  Always seeds with one `/latest` fetch first so the consumer sees the
 *  last known price immediately — necessary for equity feeds outside
 *  their active session (PRE/POST/main/ON), where the SSE channel can
 *  stay open silently with no events to deliver. */
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

  // Kick off an immediate seed fetch in parallel with the SSE open.
  // Without this, off-hours equity feeds render with no preview price
  // until the next market session — and the +/- preset buttons (which
  // gate on `pairPrice != null`) never appear.
  void (async () => {
    const u = await fetchPythLatest(id);
    if (u && alive) onUpdate(u);
  })();

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
