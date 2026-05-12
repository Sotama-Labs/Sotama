"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BorshCoder, EventParser, type Idl } from "@coral-xyz/anchor";
import type BN from "bn.js";
import { getProgram, isProgramConfigured } from "@/lib/program";
import type { Automation } from "@/lib/types";
import { isTerminal } from "@/lib/types";

const POLL_INTERVAL_MS = 60_000;
const SIG_PAGE_LIMIT = 1000;
const STORAGE_KEY = "sotama:fills-cache:v1";

export type FillRecord = {
  sig: string;
  slot: number;
  blockTime: number | null;
  automation: string;
  inputAmount: string; // u64 as decimal string — JSON can't hold u64 safely
  outputAmount: string;
};

type FillCacheEntry = {
  /** Newest signature we've already processed for this PDA. Used as the
   *  `until` cursor on the next `getSignaturesForAddress` call so we
   *  only walk new history. */
  lastSigSeen: string | null;
  fills: FillRecord[];
};

type CacheShape = Record<string, FillCacheEntry>;

function loadCache(): CacheShape {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CacheShape;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(c: CacheShape) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(c));
  } catch {
    // quota / private mode — drop silently; in-memory state still has the data
  }
}

function flattenCache(c: CacheShape): FillRecord[] {
  return Object.values(c).flatMap((e) => e.fills);
}

/** Poll the chain for `AutomationFilled` events on every owned (funded)
 *  automation PDA and cache them in localStorage. Returns the merged
 *  fill history across all known PDAs.
 *
 *  Why a separate hook from `useOnChainAutomationSync`:
 *  - That hook polls live `Automation` account state (one fetchMultiple
 *    per tick) to drive the `runs` counter and the terminal flip. It
 *    intentionally ignores history.
 *  - This hook walks log history once per refresh: `getSignaturesForAddress`
 *    with `until = lastSigSeen` returns only NEW signatures since the
 *    previous tick, then `getTransaction` per new sig decodes the
 *    `AutomationFilled` log line via Anchor's `EventParser`. Per-sig
 *    results are immutable and cached forever in localStorage, so a
 *    steady-state refresh costs roughly one `getSignaturesForAddress`
 *    per PDA + a small number of `getTransaction` calls (only for
 *    new fires since the last visit).
 *
 *  The hook is safe to mount permanently — it bails when the program
 *  isn't configured, only walks PDAs that exist on chain (`a.pubkey`
 *  set), and surfaces a closed-then-reopened PDA's history correctly
 *  because cache entries are keyed by automation pubkey, not by ID. */
export function useAutomationFills(automations: Automation[]): FillRecord[] {
  const { connection } = useConnection();
  const [fills, setFills] = useState<FillRecord[]>(() => flattenCache(loadCache()));
  const automationsRef = useRef(automations);
  automationsRef.current = automations;

  const tick = useCallback(async () => {
    if (!isProgramConfigured()) return;
    // Include terminal automations in the scan — that's exactly the
    // history we want to surface in StatsStrip. Only require a pubkey
    // (it's been on chain at some point).
    const items = automationsRef.current.filter((a) => a.pubkey);
    if (items.length === 0) return;

    // Anchor needs a wallet shim to construct Program, but we only read
    // logs — no signing. Random keypair never transmitted.
    const dummy = Keypair.generate();
    const dummyWallet = {
      publicKey: dummy.publicKey,
      signTransaction: async <T,>(tx: T) => tx,
      signAllTransactions: async <T,>(txs: T[]) => txs,
      payer: dummy,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = getProgram(connection, dummyWallet as any);
    const coder = new BorshCoder(program.idl as Idl);
    const parser = new EventParser(program.programId, coder);

    const cache = loadCache();
    let mutated = false;

    for (const a of items) {
      const pdaStr = a.pubkey!;
      const entry = cache[pdaStr] ?? { lastSigSeen: null, fills: [] };

      let pda: PublicKey;
      try {
        pda = new PublicKey(pdaStr);
      } catch {
        continue;
      }

      // For terminal automations whose lifecycle is locked in: skip the
      // sig-list refetch if we already have at least one fill recorded
      // AND the automation isn't going to fire again. Saves one RPC per
      // terminal rule per refresh.
      if (isTerminal(a) && entry.fills.length > 0) {
        continue;
      }

      let sigs;
      try {
        sigs = await connection.getSignaturesForAddress(pda, {
          limit: SIG_PAGE_LIMIT,
          until: entry.lastSigSeen ?? undefined,
        });
      } catch (e) {
        console.warn("fills: getSignaturesForAddress failed", pdaStr, e);
        continue;
      }
      if (sigs.length === 0) continue;

      const successSigs = sigs.filter((s) => s.err == null);

      // Fetch the actual tx for each — needed for the log messages.
      // Promise.all is fine here in practice (Helius handles ~50 req/s
      // and this is bounded by SIG_PAGE_LIMIT). Wrap each individually
      // so a single 429/timeout doesn't blow up the whole batch.
      const txs = await Promise.all(
        successSigs.map((s) =>
          connection
            .getTransaction(s.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: "confirmed",
            })
            .catch((err) => {
              console.warn("fills: getTransaction failed", s.signature, err);
              return null;
            }),
        ),
      );

      // If any tx couldn't be fetched, don't advance the cursor — we'd
      // skip that sig forever otherwise. Better to re-walk the same
      // page next refresh (cheap: getSignaturesForAddress is one RPC
      // call, decoded fills already in cache get re-added but the
      // sig de-dupe below collapses them).
      const anyFailed = txs.some((t) => t === null);

      const newFills: FillRecord[] = [];
      for (let i = 0; i < successSigs.length; i++) {
        const tx = txs[i];
        const sigInfo = successSigs[i];
        if (!tx) continue;
        const logs = tx.meta?.logMessages ?? [];
        let parsed;
        try {
          parsed = Array.from(parser.parseLogs(logs));
        } catch {
          continue;
        }
        for (const evt of parsed) {
          if (evt.name !== "AutomationFilled" && evt.name !== "automationFilled") {
            continue;
          }
          // IDL field types: input_amount + output_amount are u64 (BN
          // at the Anchor decoder layer). Cast through unknown to the
          // BN shape we expect.
          const data = evt.data as {
            automation?: PublicKey;
            input_amount?: BN;
            inputAmount?: BN;
            output_amount?: BN;
            outputAmount?: BN;
          };
          const automationPk = data.automation;
          const input = data.input_amount ?? data.inputAmount;
          const output = data.output_amount ?? data.outputAmount;
          if (!automationPk || !input || !output) continue;
          // The same tx CAN emit fills for multiple PDAs in a linked
          // chain — only keep the ones that belong to this PDA.
          if (automationPk.toBase58() !== pdaStr) continue;
          newFills.push({
            sig: sigInfo.signature,
            slot: sigInfo.slot,
            blockTime: sigInfo.blockTime ?? tx.blockTime ?? null,
            automation: pdaStr,
            inputAmount: input.toString(),
            outputAmount: output.toString(),
          });
        }
      }

      // Advance the cursor only when every tx fetch in this page
      // succeeded. Otherwise re-walk on the next refresh — newly
      // appended fills get de-duped against the existing cache by sig
      // before the merge below.
      const existingSigs = new Set(entry.fills.map((f) => f.sig));
      const dedupedNew = newFills.filter((f) => !existingSigs.has(f.sig));
      const newestSig = anyFailed
        ? entry.lastSigSeen
        : sigs[0]?.signature ?? entry.lastSigSeen;
      cache[pdaStr] = {
        lastSigSeen: newestSig,
        fills: [...dedupedNew, ...entry.fills],
      };
      mutated = dedupedNew.length > 0 || newestSig !== entry.lastSigSeen;
    }

    if (mutated) {
      saveCache(cache);
      setFills(flattenCache(cache));
    }
  }, [connection]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      try {
        await tick();
      } catch (e) {
        console.warn("fills tick threw:", e);
      }
      if (!stopped) {
        timer = setTimeout(loop, POLL_INTERVAL_MS);
      }
    };
    // Brief delay so the wallet provider settles before the first call.
    timer = setTimeout(loop, 1_500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);

  return fills;
}
