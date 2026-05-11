"use client";

import type { TokenRef, TokenMetadataSource } from "./types";
import { RPC_URL, MAINNET_METADATA_RPC_URL } from "./rpc";
import { fetchJupiterTokenMetadata } from "./jupiter";

/* ── Canonical mints that always resolve nicely ───────────────────── */
/* Mainnet mints; symbols + logos hold across networks. The devnet wallet
 * may not actually hold these tokens — the entries exist so pasting the
 * familiar SOL/USDC/JUP CA resolves immediately to the correct branding.
 *
 * Note: solana-labs/token-list went unmaintained in 2022, so its asset
 * paths only cover well-known mints. Runtime token resolution prefers
 * the Jupiter Token API tier (which covers basically every tradable
 * mint with up-to-date logos); these constants are the offline-safe
 * fallback for the marquee tokens. */

const STATIC_LOGO = (slug: string) =>
  `https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/${slug}/logo.png`;

const JUP_CDN = (file: string) => `https://static.jup.ag/icons/${file}`;

export const CANONICAL_MINTS: Record<string, TokenRef> = {
  "So11111111111111111111111111111111111111112": {
    mint: "So11111111111111111111111111111111111111112",
    symbol: "SOL",
    name: "Solana",
    logo: STATIC_LOGO("So11111111111111111111111111111111111111112"),
    decimals: 9,
    metadataSource: "canonical",
  },
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    logo: STATIC_LOGO("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    decimals: 6,
    metadataSource: "canonical",
  },
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    name: "Tether USD",
    logo: STATIC_LOGO("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
    decimals: 6,
    metadataSource: "canonical",
  },
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": {
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    symbol: "JUP",
    name: "Jupiter",
    logo: JUP_CDN("jup.png"),
    decimals: 6,
    metadataSource: "canonical",
  },
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": {
    mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    symbol: "BONK",
    name: "Bonk",
    logo: STATIC_LOGO("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    decimals: 5,
    metadataSource: "canonical",
  },
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": {
    mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    symbol: "JTO",
    name: "Jito",
    logo: STATIC_LOGO("jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL"),
    decimals: 9,
    metadataSource: "canonical",
  },
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": {
    mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
    symbol: "PYTH",
    name: "Pyth Network",
    logo: STATIC_LOGO("HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3"),
    decimals: 6,
    metadataSource: "canonical",
  },
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ": {
    mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ",
    symbol: "W",
    name: "Wormhole",
    logo: STATIC_LOGO("85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ"),
    decimals: 6,
    metadataSource: "canonical",
  },
};

/** A handful of known devnet test mints so users can paste familiar CAs while testing. */
export const CANONICAL_DEVNET_MINTS: Record<string, TokenRef> = {
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    symbol: "USDC",
    name: "USD Coin (Test)",
    logo: STATIC_LOGO("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    decimals: 6,
    metadataSource: "canonical",
  },
};

/** Stable list (canonical mainnet only) used as the TokenPicker's default suggestions. */
export const POPULAR_TOKENS: TokenRef[] = Object.values(CANONICAL_MINTS);

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/* ── Base58 mint validation ────────────────────────────────────────── */

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidMintCandidate(input: string): boolean {
  return BASE58_RE.test(input.trim());
}

/* ── Resolver: paste CA → TokenRef via 4-tier fallback ─────────────── */

type CacheEntry = { token: TokenRef; cachedAt: number };
const memoryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = "sotama:token-cache:v1";

function loadStorageCache(): Record<string, CacheEntry> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function saveStorageCache(map: Record<string, CacheEntry>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // quota / private mode — silently skip
  }
}

function readCache(mint: string): TokenRef | null {
  const mem = memoryCache.get(mint);
  if (mem && Date.now() - mem.cachedAt < CACHE_TTL_MS) return mem.token;
  const disk = loadStorageCache()[mint];
  if (disk && Date.now() - disk.cachedAt < CACHE_TTL_MS) {
    memoryCache.set(mint, disk);
    return disk.token;
  }
  return null;
}

function writeCache(token: TokenRef) {
  const entry: CacheEntry = { token, cachedAt: Date.now() };
  memoryCache.set(token.mint, entry);
  const disk = loadStorageCache();
  disk[token.mint] = entry;
  saveStorageCache(disk);
}

type DasAsset = {
  interface?: string;
  id?: string;
  content?: {
    metadata?: { name?: string; symbol?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string }>;
  };
  token_info?: { decimals?: number; symbol?: string };
};

async function fetchDasAsset(rpcUrl: string, mint: string): Promise<DasAsset | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "sotama-token",
        method: "getAsset",
        params: { id: mint, displayOptions: { showFungible: true } },
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { result?: DasAsset; error?: unknown };
    return json.result ?? null;
  } catch {
    return null;
  }
}

function dasToTokenRef(
  mint: string,
  asset: DasAsset | null,
  source: TokenMetadataSource,
): TokenRef | null {
  if (!asset) return null;
  const symbol = asset.token_info?.symbol || asset.content?.metadata?.symbol;
  const decimals = asset.token_info?.decimals;
  if (!symbol || decimals == null) return null;
  const logo =
    asset.content?.links?.image ||
    asset.content?.files?.find((f) => f.cdn_uri)?.cdn_uri ||
    asset.content?.files?.find((f) => f.uri)?.uri ||
    undefined;
  return {
    mint,
    symbol,
    name: asset.content?.metadata?.name || symbol,
    logo,
    decimals,
    metadataSource: source,
  };
}

export type ResolveResult =
  | { status: "ok"; token: TokenRef }
  | { status: "manual"; mint: string }
  | { status: "invalid" };

/** Resolve a pasted contract address to a TokenRef, with cache + fallback chain. */
export async function resolveToken(input: string): Promise<ResolveResult> {
  const mint = input.trim();
  if (!isValidMintCandidate(mint)) return { status: "invalid" };

  const cached = readCache(mint);
  if (cached) return { status: "ok", token: cached };

  if (CANONICAL_MINTS[mint]) {
    const token = CANONICAL_MINTS[mint];
    writeCache(token);
    return { status: "ok", token };
  }
  if (CANONICAL_DEVNET_MINTS[mint]) {
    const token = CANONICAL_DEVNET_MINTS[mint];
    writeCache(token);
    return { status: "ok", token };
  }

  // Jupiter Token API — covers basically every tradable Solana token
  // with current logos. Sits ahead of the DAS RPCs because most pasted
  // CAs are mainnet tokens, and Jupiter resolves them correctly with a
  // logo even when the local devnet RPC has no metadata for them.
  const fromJupiter = await fetchJupiterTokenMetadata(mint);
  if (fromJupiter) {
    const token: TokenRef = {
      mint: fromJupiter.mint,
      symbol: fromJupiter.symbol,
      name: fromJupiter.name,
      logo: fromJupiter.logo,
      decimals: fromJupiter.decimals,
      metadataSource: "mainnet",
    };
    writeCache(token);
    return { status: "ok", token };
  }

  const devnetAsset = await fetchDasAsset(RPC_URL, mint);
  const fromDevnet = dasToTokenRef(mint, devnetAsset, "devnet");
  if (fromDevnet) {
    writeCache(fromDevnet);
    return { status: "ok", token: fromDevnet };
  }

  if (MAINNET_METADATA_RPC_URL) {
    const mainnetAsset = await fetchDasAsset(MAINNET_METADATA_RPC_URL, mint);
    const fromMainnet = dasToTokenRef(mint, mainnetAsset, "mainnet");
    if (fromMainnet) {
      writeCache(fromMainnet);
      return { status: "ok", token: fromMainnet };
    }
  }

  return { status: "manual", mint };
}

/** Build a manual-entry TokenRef when the user fills symbol/decimals by hand. */
export function manualTokenRef(mint: string, symbol: string, decimals: number, name?: string): TokenRef {
  const t: TokenRef = {
    mint,
    symbol: symbol.toUpperCase().slice(0, 12) || "TOKEN",
    name: name || symbol,
    decimals,
    metadataSource: "manual",
  };
  writeCache(t);
  return t;
}

export function metadataSourceLabel(src: TokenMetadataSource): string {
  switch (src) {
    case "canonical":
      return "canonical";
    case "devnet":
      return "test network";
    case "mainnet":
      return "on-chain";
    case "manual":
      return "entered manually";
  }
}
