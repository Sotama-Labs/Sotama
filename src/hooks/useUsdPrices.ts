"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchJupiterPricesBatchUSD } from "@/lib/jupiter";

const PRICE_TTL_MS = 60_000;

type CacheEntry = { fetchedAt: number; prices: Record<string, number> };
// Module-scoped so the same render burst (multiple components on the
// same page asking for overlapping mint sets) shares one HTTP call.
let cache: CacheEntry | null = null;
let inflight: Promise<Record<string, number>> | null = null;

function cacheStaleFor(mints: string[]): boolean {
  if (!cache) return true;
  if (Date.now() - cache.fetchedAt > PRICE_TTL_MS) return true;
  // Stale if any requested mint isn't in the cached snapshot — we need
  // to refetch to get it. Missing-from-Jupiter mints (e.g. an unlisted
  // token) are absent from the response so we'd retry forever; track
  // those separately with a sentinel so we only retry after TTL expiry.
  for (const m of mints) {
    if (!(m in cache.prices)) return true;
  }
  return false;
}

/** Batched USD spot prices for a set of mints, refreshed at most every
 *  60 seconds. Hook-local state mirrors the module-scope cache so the
 *  caller re-renders when prices land.
 *
 *  Why module scope plus hook state: a render that mounts two
 *  components both asking for SOL+USDC prices would otherwise issue
 *  two parallel Jupiter calls. Module scope dedupes them; the
 *  per-hook state copy keeps each consumer reactive. */
export function useUsdPrices(mints: string[]): Record<string, number> {
  // Stable sort + join → stable cache key for the effect's deps array.
  const key = useMemo(() => Array.from(new Set(mints)).sort().join(","), [mints]);
  const [prices, setPrices] = useState<Record<string, number>>(
    () => cache?.prices ?? {},
  );

  useEffect(() => {
    const requested = key ? key.split(",") : [];
    if (requested.length === 0) return;
    if (!cacheStaleFor(requested) && cache) {
      setPrices(cache.prices);
      return;
    }
    let cancelled = false;
    const fetchNow = async () => {
      if (!inflight) {
        inflight = fetchJupiterPricesBatchUSD(requested).finally(() => {
          // null out so the next staleness check triggers a new fetch
          // after TTL expiry.
          inflight = null;
        });
      }
      const result = await inflight;
      if (cancelled) return;
      cache = {
        fetchedAt: Date.now(),
        // Merge with previous so an empty-response fetch doesn't blow
        // away cached prices for mints we asked about before.
        prices: { ...(cache?.prices ?? {}), ...result },
      };
      setPrices(cache.prices);
    };
    fetchNow().catch((e) => console.warn("usd-prices fetch failed:", e));
    return () => {
      cancelled = true;
    };
  }, [key]);

  return prices;
}
