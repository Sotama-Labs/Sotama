"use client";

import { Connection, PublicKey } from "@solana/web3.js";
import type { TokenRef, TokenMetadataSource } from "./types";
import { RPC_URL, MAINNET_METADATA_RPC_URL } from "./rpc";
import { fetchJupiterTokenMetadata } from "./jupiter";

/** Token-2022 mint extension type code for the TransferHook extension.
 *  Hook code runs via CPI on every transfer and can fail closed, drain
 *  ATAs, or sandwich the caller — we can't safely relay a Jupiter swap
 *  through such a mint. Other Token-2022 extensions (transfer fees,
 *  confidential transfers, metadata, …) are fine because
 *  `transfer_checked` handles them deterministically.
 *  Reference: spl-token-2022/src/extension/mod.rs, ExtensionType variants. */
const EXTENSION_TYPE_TRANSFER_HOOK = 14;

/** Parse a Token-2022 Mint account's TLV extension list and return
 *  `true` iff the `TransferHook` extension is present. Returns `false`
 *  for legacy SPL mints (which have no extension area) and for
 *  Token-2022 mints that don't carry the hook.
 *
 *  Layout (spl-token-2022):
 *    bytes 0-81  : base mint data (same as legacy SPL)
 *    bytes 82-164: zero padding to the standard token-account length (165)
 *    byte  165   : account-type marker (1 = Mint) — only present when the
 *                  mint has at least one extension
 *    bytes 166+  : repeated TLV records:
 *                    u16 LE extension type
 *                    u16 LE extension length
 *                    `length` bytes of extension data
 *
 *  Mints exactly 82 bytes long have no extensions. We only scan past 166
 *  if the data length warrants it. */
function mintBytesContainTransferHook(raw: Uint8Array): boolean {
  if (raw.length <= 165) return false; // legacy SPL or extension-less Token-2022
  // Optional sanity: byte 165 should be 1 (Mint marker) but the TLV scan
  // is conservative regardless — if the marker is missing we'd just walk
  // off the end without matching anything.
  let offset = 166;
  while (offset + 4 <= raw.length) {
    const extType = raw[offset] | (raw[offset + 1] << 8);
    const extLen = raw[offset + 2] | (raw[offset + 3] << 8);
    if (extType === EXTENSION_TYPE_TRANSFER_HOOK) return true;
    // 0 = Uninitialized — end of TLV list (or zero-padding). Stop.
    if (extType === 0) return false;
    offset += 4 + extLen;
  }
  return false;
}

/** True iff `mint`'s on-chain account carries the TransferHook
 *  extension. Performs ONE `getAccountInfo` and returns `false` on any
 *  error (cautious default — if we can't tell, we let the standard
 *  validation flow decide). For Token-2022 mints flagged here, we
 *  reject at the picker so the user sees a clean explanation before
 *  attempting to fund an automation. */
async function mintHasTransferHook(rpcUrl: string, mint: string): Promise<boolean> {
  try {
    const conn = new Connection(rpcUrl, "confirmed");
    const info = await conn.getAccountInfo(new PublicKey(mint), "confirmed");
    if (!info) return false;
    const bytes = info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
    return mintBytesContainTransferHook(bytes);
  } catch {
    return false;
  }
}

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

/** Token program IDs. Token-2022 mints WITHOUT `transfer_hook` are now
 *  supported end-to-end (program uses `token_interface::transfer_checked`
 *  which dispatches to either runtime). Hook-bearing mints stay
 *  blocked because the hook can execute arbitrary CPI on every
 *  transfer — a hostile-code surface we won't relay. */
const REGULAR_SPL_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type ResolveResult =
  | { status: "ok"; token: TokenRef }
  | { status: "manual"; mint: string }
  | { status: "invalid" }
  | {
      /** Mint is a Token-2022 mint carrying the `transfer_hook`
       *  extension. The hook runs arbitrary CPI on every transfer and
       *  is unsafe to relay; the on-chain program refuses these at
       *  create time too. Surface a clean "not supported" message so
       *  users don't waste a tx attempting it. */
      status: "transfer_hook_unsupported";
      mint: string;
      symbol: string;
      name: string;
    }
  | {
      /** Mint is owned by some program other than legacy SPL or
       *  Token-2022. Almost certainly an NFT or a misformed token; we
       *  can't route swaps through it. */
      status: "unknown_token_program";
      mint: string;
      symbol: string;
      name: string;
      tokenProgram: string;
    };

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
    // Allow legacy SPL and Token-2022 mints; reject anything else.
    // The on-chain program now uses `Interface<TokenInterface>` so
    // both runtimes work end-to-end — but Token-2022 mints that
    // carry the `transfer_hook` extension stay blocked because the
    // hook can run arbitrary CPI on every transfer (security gate
    // matched by the program's `assert_no_transfer_hook` check).
    if (
      fromJupiter.tokenProgram &&
      fromJupiter.tokenProgram !== REGULAR_SPL_TOKEN_PROGRAM &&
      fromJupiter.tokenProgram !== TOKEN_2022_PROGRAM
    ) {
      return {
        status: "unknown_token_program",
        mint: fromJupiter.mint,
        symbol: fromJupiter.symbol,
        name: fromJupiter.name,
        tokenProgram: fromJupiter.tokenProgram,
      };
    }
    if (fromJupiter.tokenProgram === TOKEN_2022_PROGRAM) {
      // One on-chain probe to confirm the mint isn't carrying the
      // hostile `transfer_hook` extension. The on-chain program would
      // also reject at create time, but failing here saves the user
      // a wasted signing flow.
      const hasHook = await mintHasTransferHook(RPC_URL, fromJupiter.mint);
      if (hasHook) {
        return {
          status: "transfer_hook_unsupported",
          mint: fromJupiter.mint,
          symbol: fromJupiter.symbol,
          name: fromJupiter.name,
        };
      }
    }
    const token: TokenRef = {
      mint: fromJupiter.mint,
      symbol: fromJupiter.symbol,
      name: fromJupiter.name,
      logo: fromJupiter.logo,
      decimals: fromJupiter.decimals,
      metadataSource: "mainnet",
      tokenProgram: fromJupiter.tokenProgram,
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
