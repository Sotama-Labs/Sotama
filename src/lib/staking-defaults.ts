"use client";

import { CLUSTER, getRpc } from "./rpc";

/**
 * Helius's mainnet vote account — vanity-prefixed `he1ius…` so it's
 * recognizable in lists and explorers. Confirmed via validators.app,
 * solanabeach, and solanacompass. The `helius-sdk`'s
 * `getStakeInstructions` delegates new stake accounts to this same
 * pubkey, so pre-filling it here matches what Helius's docs recommend.
 *
 * Source: https://www.helius.dev/docs/staking/how-to-stake-with-helius-programmatically
 */
export const HELIUS_MAINNET_VOTE_ACCOUNT =
  "he1iusunGwqrNtafDtLdhsUQDFvo13z9sUa36PauBtk";

let cachedDevnetVoteAccount: string | null = null;
let inflightDevnet: Promise<string | null> | null = null;

/** Resolve a sensible default vote account for the current cluster.
 *
 *  • mainnet-beta → `HELIUS_MAINNET_VOTE_ACCOUNT`.
 *  • devnet       → uniformly-random current (non-delinquent) validator
 *                   from `getVoteAccounts`. Cached after the first call
 *                   so the builder doesn't reshuffle every time the
 *                   editor opens.
 *  • Failure      → `null`. Caller leaves the field empty and lets the
 *                   user paste their own pubkey.
 */
export async function getDefaultVoteAccount(): Promise<string | null> {
  if (CLUSTER === "mainnet-beta") {
    return HELIUS_MAINNET_VOTE_ACCOUNT;
  }
  if (cachedDevnetVoteAccount) return cachedDevnetVoteAccount;
  if (inflightDevnet) return inflightDevnet;

  inflightDevnet = (async () => {
    try {
      const res = await getRpc().getVoteAccounts().send();
      const current = res.current;
      if (!current || current.length === 0) return null;
      const pick = current[Math.floor(Math.random() * current.length)];
      cachedDevnetVoteAccount = pick.votePubkey as unknown as string;
      return cachedDevnetVoteAccount;
    } catch (e) {
      console.warn("getDefaultVoteAccount: getVoteAccounts failed", e);
      return null;
    } finally {
      inflightDevnet = null;
    }
  })();
  return inflightDevnet;
}
