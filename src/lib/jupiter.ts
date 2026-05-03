// Jupiter Price API v3.
// Default: api.jup.ag (keyless at 0.5 RPS — fine for a single-mint 15s poll).
// lite-api.jup.ag is being progressively retired since the Developer Platform
// launch on 2026-04-06; new traffic should target api.jup.ag.
// Set NEXT_PUBLIC_JUPITER_API_KEY=<key from https://portal.jup.ag> for higher
// rate limits — sent via the x-api-key header.
// Reference: https://dev.jup.ag/docs/price/ and https://dev.jup.ag/docs/portal/migration
const ENDPOINT =
  process.env.NEXT_PUBLIC_JUPITER_PRICE_URL || "https://api.jup.ag/price/v3";
const API_KEY = process.env.NEXT_PUBLIC_JUPITER_API_KEY;

// Canonical mints we care about for the v0 trigger/action catalog.
export const MINTS = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const;

export type PriceMap = Record<
  string,
  { usdPrice: number; priceChange24h: number | null; updatedAt: number }
>;

// Per Jupiter docs: max 50 ids per request.
const MAX_IDS = 50;

type PriceEntry = { usdPrice?: number; priceChange24h?: number };

export async function fetchPrices(mints: string[], signal?: AbortSignal): Promise<PriceMap> {
  if (mints.length === 0) return {};
  if (mints.length > MAX_IDS) {
    throw new Error(`Jupiter price API accepts up to ${MAX_IDS} ids per request`);
  }
  const url = `${ENDPOINT}?ids=${mints.join(",")}`;
  const headers: Record<string, string> = {};
  if (API_KEY) headers["x-api-key"] = API_KEY;
  const res = await fetch(url, { signal, cache: "no-store", headers });
  if (!res.ok) throw new Error(`Jupiter ${res.status}`);
  const json = (await res.json()) as Record<string, PriceEntry>;
  const out: PriceMap = {};
  const now = Date.now();
  for (const mint of mints) {
    const entry = json[mint];
    if (entry?.usdPrice != null) {
      out[mint] = {
        usdPrice: entry.usdPrice,
        priceChange24h: entry.priceChange24h ?? null,
        updatedAt: now,
      };
    }
  }
  return out;
}
