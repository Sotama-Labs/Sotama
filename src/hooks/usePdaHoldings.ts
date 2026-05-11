"use client";

import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { RPC_URL } from "@/lib/rpc";
import { resolveToken } from "@/lib/tokens";
import type { TokenRef } from "@/lib/types";

/** SPL Token program (Token, not Token-2022). */
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);

/** Token-2022 program — surfaces some newer mints. */
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

/**
 * Same-refreshKey debounce. If a fetch already finished in the last
 * 2s for `(pda, refreshKey)`, a re-mount, sibling row, or page refresh
 * gets the cached value instead of firing another round-trip. Covers
 * human-rate F5 mashing (~3-5 refreshes/sec) without missing real
 * updates — those bump refreshKey and bypass this window entirely.
 */
const SAME_REFRESH_DEBOUNCE_MS = 2_000;

/**
 * Cross-page-refresh display TTL. Older than this and we show a
 * `loading` state on mount instead of stale numbers (we still fetch).
 */
const SESSION_HYDRATE_TTL_MS = 30_000;

export type PdaTokenHolding = {
  mint: string;
  /** Raw on-chain amount (smallest units). */
  amount: bigint;
  /** Decimal-adjusted human-readable amount. */
  uiAmount: number;
  /** Resolved token metadata, or `null` if unresolved. */
  token: TokenRef | null;
};

export type PdaHoldingsResult = {
  tokens: PdaTokenHolding[];
  /** SOL above the account's rent-exempt minimum (in SOL, not lamports). */
  extraSol: number;
  loading: boolean;
  error: string | null;
};

const EMPTY: PdaHoldingsResult = {
  tokens: [],
  extraSol: 0,
  loading: false,
  error: null,
};

/* ── Module-level RPC dedup + cache ───────────────────────────────────
 *
 * These structures outlive individual hook instances so that:
 *   - N rows mounting the same `pda` share one in-flight fetch.
 *   - Rapid `refreshKey` churn for the same value collapses to one fetch.
 *   - Effect re-runs (React Strict Mode double-mount, Fast Refresh)
 *     never re-hit the RPC.
 *
 * Distinct `refreshKey` values bypass the cache — that's the signal
 * meaning "the keeper actually executed something, fetch fresh data".
 */
type CacheEntry = {
  value: PdaHoldingsResult;
  /** `performance.now()` at write time. Compared against
   *  `SAME_REFRESH_DEBOUNCE_MS` to decide cache freshness. */
  monoTimestamp: number;
  /** `Date.now()` at write time. Persisted to sessionStorage so the
   *  cross-refresh hydration knows whether the snapshot is stale. */
  wallTimestamp: number;
  /** The `refreshKey` the entry was fetched at. Cache only serves when
   *  the requesting hook's `refreshKey` matches. */
  refreshKey: number | string;
};

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PdaHoldingsResult>>();

let sharedConnection: Connection | null = null;
function getConnection(): Connection {
  if (!sharedConnection) {
    sharedConnection = new Connection(RPC_URL, "confirmed");
  }
  return sharedConnection;
}

/* ── sessionStorage hydration (cross-refresh) ─────────────────────── */

function sessionStorageKey(pda: string): string {
  return `sotama:pdaHoldings:v1:${pda}`;
}

type SerializedEntry = {
  tokens: Array<Omit<PdaTokenHolding, "amount"> & { amount: string }>;
  extraSol: number;
  wallTimestamp: number;
  refreshKey: number | string;
};

function readSession(pda: string): CacheEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(sessionStorageKey(pda));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SerializedEntry;
    if (Date.now() - parsed.wallTimestamp > SESSION_HYDRATE_TTL_MS) return null;
    return {
      value: {
        tokens: parsed.tokens.map((t) => ({
          ...t,
          amount: BigInt(t.amount),
        })),
        extraSol: parsed.extraSol,
        loading: false,
        error: null,
      },
      // Treat as stale in monoTimestamp space so the foreground fetch
      // still runs — we want to display something fast but always
      // verify against fresh chain state.
      monoTimestamp: -Infinity,
      wallTimestamp: parsed.wallTimestamp,
      refreshKey: parsed.refreshKey,
    };
  } catch {
    return null;
  }
}

function writeSession(pda: string, entry: CacheEntry): void {
  if (typeof window === "undefined") return;
  try {
    const serialized: SerializedEntry = {
      tokens: entry.value.tokens.map((t) => ({
        ...t,
        amount: t.amount.toString(),
      })),
      extraSol: entry.value.extraSol,
      wallTimestamp: entry.wallTimestamp,
      refreshKey: entry.refreshKey,
    };
    window.sessionStorage.setItem(
      sessionStorageKey(pda),
      JSON.stringify(serialized),
    );
  } catch {
    /* sessionStorage may be unavailable (private browsing limits) — silent fallback */
  }
}

/* ── Actual fetch (singleton per (pda, refreshKey)) ──────────────── */

async function fetchHoldingsImpl(pda: string): Promise<PdaHoldingsResult> {
  const connection = getConnection();
  let pubkey: PublicKey;
  try {
    pubkey = new PublicKey(pda);
  } catch (e) {
    return { ...EMPTY, error: `invalid pubkey: ${String(e)}` };
  }

  const [accountInfo, splAccounts, t22Accounts] = await Promise.all([
    connection.getAccountInfo(pubkey, "confirmed"),
    connection.getTokenAccountsByOwner(
      pubkey,
      { programId: TOKEN_PROGRAM_ID },
      "confirmed",
    ),
    connection
      .getTokenAccountsByOwner(
        pubkey,
        { programId: TOKEN_2022_PROGRAM_ID },
        "confirmed",
      )
      .catch(() => ({ value: [] })),
  ]);

  // SOL above rent-exempt minimum. If the PDA was closed, the account
  // is null and there's nothing to display.
  let extraSol = 0;
  if (accountInfo) {
    const dataLen = accountInfo.data.length;
    const rentMin = await connection.getMinimumBalanceForRentExemption(dataLen);
    const extraLamports = Math.max(0, accountInfo.lamports - rentMin);
    extraSol = extraLamports / 1e9;
  }

  // Parse SPL token-account layouts (mint @ 0..32, amount @ 64..72).
  const rawHoldings: { mint: string; amount: bigint }[] = [];
  const ingest = (accs: typeof splAccounts.value) => {
    for (const a of accs) {
      const data = a.account.data;
      if (data.length < 72) continue;
      const mint = new PublicKey(data.subarray(0, 32)).toBase58();
      const amount = data.readBigUInt64LE(64);
      if (amount > 0n) rawHoldings.push({ mint, amount });
    }
  };
  ingest(splAccounts.value);
  ingest(t22Accounts.value);

  const tokens = await Promise.all(
    rawHoldings.map(async (h) => {
      const r = await resolveToken(h.mint);
      const token = r.status === "ok" ? r.token : null;
      const decimals = token?.decimals ?? 0;
      const uiAmount = Number(h.amount) / Math.pow(10, decimals);
      return { mint: h.mint, amount: h.amount, uiAmount, token };
    }),
  );

  return { tokens, extraSol, loading: false, error: null };
}

function isDebounced(entry: CacheEntry, refreshKey: number | string): boolean {
  if (entry.refreshKey !== refreshKey) return false;
  const monoAge = performance.now() - entry.monoTimestamp;
  if (monoAge < SAME_REFRESH_DEBOUNCE_MS) return true;
  // sessionStorage-hydrated entries land with monoTimestamp == -Infinity
  // (the in-process clock just started), so the in-memory `monoAge`
  // check would never debounce them. Fall back to wall-clock age,
  // which is what we actually care about for cross-refresh spam.
  const wallAge = Date.now() - entry.wallTimestamp;
  return wallAge < SAME_REFRESH_DEBOUNCE_MS;
}

function getOrFetch(
  pda: string,
  refreshKey: number | string,
): { sync: PdaHoldingsResult | null; promise: Promise<PdaHoldingsResult> } {
  // 1. In-memory cache — covers same-session re-mounts + sibling rows.
  let cached = cache.get(pda);
  if (cached && isDebounced(cached, refreshKey)) {
    return { sync: cached.value, promise: Promise.resolve(cached.value) };
  }

  // 2. sessionStorage — covers cross-refresh re-mounts. We lift the
  //    entry into the in-memory cache so any subsequent siblings hit
  //    path (1) without re-parsing JSON.
  if (!cached) {
    const fromSession = readSession(pda);
    if (fromSession) {
      cache.set(pda, fromSession);
      cached = fromSession;
      if (isDebounced(fromSession, refreshKey)) {
        return {
          sync: fromSession.value,
          promise: Promise.resolve(fromSession.value),
        };
      }
    }
  }

  // 3. In-flight dedup — sibling rows mounting the same PDA in the
  //    same tick share the active fetch.
  const existing = inFlight.get(pda);
  if (existing) {
    return { sync: cached?.value ?? null, promise: existing };
  }

  // 4. Start a fresh fetch.
  const promise = fetchHoldingsImpl(pda)
    .then((value) => {
      const entry: CacheEntry = {
        value,
        monoTimestamp: performance.now(),
        wallTimestamp: Date.now(),
        refreshKey,
      };
      cache.set(pda, entry);
      writeSession(pda, entry);
      return value;
    })
    .finally(() => {
      inFlight.delete(pda);
    });
  inFlight.set(pda, promise);
  return { sync: cached?.value ?? null, promise };
}

/**
 * Fetch the SPL token balances + extra SOL of a single PDA.
 *
 * "Extra SOL" excludes the rent-exempt minimum so the displayed number
 * reflects only what the strategy actively holds. Token balances are
 * unfiltered (any non-zero ATA owned by the PDA).
 *
 * Re-fetches on three signals only — never on a fixed timer:
 *   1. Mount (page load / soft navigation)
 *   2. `pda` changes
 *   3. `refreshKey` changes — caller-supplied. The intended driver is
 *      an aggregate of execution markers across all visible automations
 *      (e.g. `sum(a.runs) + count(closed)`), so any upstream-chain leg
 *      firing also refreshes downstream PDAs whose input ATA just got
 *      credited.
 *
 * RPC spam protection:
 *   - In-memory cache: dedupes identical (pda, refreshKey) within 500ms.
 *   - In-flight Map: sibling rows mounting the same PDA share one fetch.
 *   - sessionStorage: a `window.location.reload()` rehydrates the last
 *     snapshot (< 30s old) before the background fetch resolves.
 */
export function usePdaHoldings(
  pda: string | null | undefined,
  {
    enabled = true,
    refreshKey = 0,
  }: { enabled?: boolean; refreshKey?: number | string } = {},
): PdaHoldingsResult {
  const [state, setState] = useState<PdaHoldingsResult>(() => {
    if (!pda || !enabled) return EMPTY;
    // Synchronous cache lookup on mount — avoids a "loading" flash for
    // rows whose PDA was already fetched in this session.
    const cached = cache.get(pda);
    if (cached && cached.refreshKey === refreshKey) return cached.value;
    const fromSession = readSession(pda);
    if (fromSession && fromSession.refreshKey === refreshKey) {
      cache.set(pda, fromSession);
      return fromSession.value;
    }
    return { ...EMPTY, loading: true };
  });

  useEffect(() => {
    if (!pda || !enabled) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const { sync, promise } = getOrFetch(pda, refreshKey);
    if (sync) setState(sync);

    promise.then(
      (value) => {
        if (!cancelled) setState(value);
      },
      (err) => {
        if (!cancelled) {
          setState((s) => ({
            ...s,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [pda, enabled, refreshKey]);

  return state;
}
