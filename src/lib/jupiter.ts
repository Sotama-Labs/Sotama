/* ─────────────────────────────────────────────────────────────────────
   Jupiter Lite API helpers — price + token metadata.

   Two responsibilities:

     1. **Price** — the fallback when an SPL token has no Pyth feed.
        Used by `resolveOracleForPair` in oracles.ts. Adding a new
        provider (Switchboard, Birdeye, …) is a new resolver in that
        file, not a change here.

     2. **Token metadata + logo** — primary tier for resolving a pasted
        contract address. Replaces the deprecated solana-labs/token-list
        for everything outside the canonical hardcoded mints. Used by
        `resolveToken` in tokens.ts.

   Endpoints come from env so they can be swapped without redeploying
   (e.g. routing through a self-hosted mirror or a gateway). Defaults to
   the public lite-api endpoints for zero-config dev.
   ───────────────────────────────────────────────────────────────────── */

const JUPITER_PRICE_URL =
  process.env.NEXT_PUBLIC_JUPITER_PRICE_URL || "https://lite-api.jup.ag/price/v3";
const JUPITER_TOKENS_URL =
  process.env.NEXT_PUBLIC_JUPITER_TOKENS_URL ||
  "https://lite-api.jup.ag/tokens/v2/search";
/** Optional Pro key. Free tier (lite-api.jup.ag) ignores it; paid tier
 *  (api.jup.ag) requires it for higher rate limits and Pro endpoints. */
const JUPITER_API_KEY = process.env.NEXT_PUBLIC_JUPITER_API_KEY || "";

function jupiterHeaders(): HeadersInit {
  return JUPITER_API_KEY ? { "x-api-key": JUPITER_API_KEY } : {};
}

/** Live USD price for an SPL mint, normalized to the on-chain wire format
 *  used by AssetPrice triggers (`raw * 10^expo`). Returns `null` when
 *  Jupiter doesn't index the mint or returns a non-finite price.
 *
 *  `expo = -6` matches USDC's native decimals — the same scale the
 *  keeper applies, so the threshold the user enters in the UI lines up
 *  byte-for-byte with the comparison the keeper performs. */
export async function fetchJupiterPriceUSD(
  mint: string,
): Promise<{ price: number; expo: number } | null> {
  if (!mint) return null;
  const url = `${JUPITER_PRICE_URL}?ids=${encodeURIComponent(mint)}`;
  try {
    const res = await fetch(url, { cache: "no-store", headers: jupiterHeaders() });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<
      string,
      { usdPrice?: number | null } | undefined
    >;
    const entry = json?.[mint];
    if (!entry) return null;
    const usd = entry.usdPrice;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
    return { price: usd, expo: -6 };
  } catch {
    return null;
  }
}

/** Token metadata from Jupiter's tokens-v2 search endpoint. The mint is
 *  passed as the query string so the endpoint returns a single (or
 *  near-single) result keyed by ticker substring match — the first hit
 *  whose `address` matches the mint is the canonical one. */
export type JupiterTokenMetadata = {
  mint: string;
  symbol: string;
  name: string;
  logo?: string;
  decimals: number;
};

type JupiterTokenSearchResult = {
  /** Jupiter v2 Search returns the SPL mint as `id`. */
  id?: string;
  /** Older v1 token endpoints used `address`; preserved as a fallback. */
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  /** v2 returns the logo at `icon`; v1 used `logoURI`. */
  icon?: string;
  logoURI?: string;
};

export async function fetchJupiterTokenMetadata(
  mint: string,
): Promise<JupiterTokenMetadata | null> {
  if (!mint) return null;
  const url = `${JUPITER_TOKENS_URL}?query=${encodeURIComponent(mint)}`;
  try {
    const res = await fetch(url, { cache: "no-store", headers: jupiterHeaders() });
    if (!res.ok) return null;
    const json = (await res.json()) as JupiterTokenSearchResult[];
    if (!Array.isArray(json)) return null;
    // Match by exact mint address rather than first result — search can
    // return tokens whose ticker happens to match a substring of the
    // mint. v2 surfaces the mint at `id`; older endpoints used `address`.
    const hit = json.find((t) => (t.id ?? t.address) === mint);
    if (!hit) return null;
    if (!hit.symbol || typeof hit.decimals !== "number") return null;
    return {
      mint,
      symbol: hit.symbol,
      name: hit.name || hit.symbol,
      logo: hit.icon || hit.logoURI || undefined,
      decimals: hit.decimals,
    };
  } catch {
    return null;
  }
}
