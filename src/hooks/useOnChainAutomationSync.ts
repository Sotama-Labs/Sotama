"use client";

import { useCallback, useEffect, useRef } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getProgram, isProgramConfigured } from "@/lib/program";
import type { Automation } from "@/lib/types";
import { isTerminal } from "@/lib/types";
import { isDemoMode } from "@/lib/demo/demo";

const POLL_INTERVAL_MS = 10_000;

/** Polls the on-chain `Automation` PDA for every funded, non-terminal
 *  local automation. When the on-chain `executed: bool` flips to true
 *  (single-shot), the local automation is patched with `executedAt`,
 *  `runs >= 1`, and `running: false`. When the on-chain account is
 *  closed (owner refund), `closedAt` is set instead.
 *
 *  The hook is safe to mount permanently — it bails immediately when
 *  `isProgramConfigured()` is false, and it only RPC-fetches automations
 *  that haven't already reached their terminal state. */
export function useOnChainAutomationSync(
  automations: Automation[],
  patch: (id: string, partial: Partial<Automation>) => void,
) {
  const { connection } = useConnection();
  const automationsRef = useRef(automations);
  automationsRef.current = automations;

  const patchRef = useRef(patch);
  patchRef.current = patch;

  const tick = useCallback(async () => {
    // Demo mode: seeded automations already carry their final runs /
    // executedAt, so there's nothing to poll — and no RPC to call.
    if (isDemoMode()) return;
    if (!isProgramConfigured()) return;
    const items = automationsRef.current.filter((a) => a.pubkey && !isTerminal(a));
    if (items.length === 0) return;

    // Anchor's Program needs a wallet shim for typing, but read-only ops
    // never sign anything — a randomly-generated dummy keypair is fine
    // and never transmitted.
    const dummy = Keypair.generate();
    const dummyWallet = {
      publicKey: dummy.publicKey,
      signTransaction: async <T,>(tx: T) => tx,
      signAllTransactions: async <T,>(txs: T[]) => txs,
      payer: dummy,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const program = getProgram(connection, dummyWallet as any);

    let pubkeys: PublicKey[];
    try {
      pubkeys = items.map((a) => new PublicKey(a.pubkey!));
    } catch (e) {
      console.warn("on-chain sync: bad pubkey in localStorage", e);
      return;
    }

    let accounts: Array<unknown>;
    try {
      accounts = await program.account.automation.fetchMultiple(pubkeys);
    } catch (e) {
      console.warn("on-chain sync: fetchMultiple failed", e);
      return;
    }

    const now = new Date().toISOString();
    for (let i = 0; i < items.length; i++) {
      const local = items[i];
      const remote = accounts[i] as
        | {
            finished?: boolean;
            executions?: { toString(): string };
            executedAt?: { toString(): string };
          }
        | null;
      if (remote == null) {
        // Owner closed the account — local goes terminal as "closed".
        patchRef.current(local.id, {
          closedAt: now,
          running: false,
          lastCheck: now,
        });
        continue;
      }
      const onChainRuns = remote.executions
        ? Number(remote.executions.toString())
        : 0;
      if (remote.finished === true) {
        const onChainExecutedAtSec =
          remote.executedAt && Number(remote.executedAt.toString());
        const executedAtIso =
          onChainExecutedAtSec && onChainExecutedAtSec > 0
            ? new Date(onChainExecutedAtSec * 1000).toISOString()
            : now;
        patchRef.current(local.id, {
          executedAt: executedAtIso,
          runs: Math.max(local.runs, onChainRuns || 1),
          running: false,
          lastCheck: now,
        });
      } else {
        patchRef.current(local.id, {
          lastCheck: now,
          runs: Math.max(local.runs, onChainRuns),
        });
      }
    }
  }, [connection]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      try {
        await tick();
      } catch (e) {
        console.warn("on-chain sync tick threw:", e);
      }
      if (!stopped) {
        timer = setTimeout(loop, POLL_INTERVAL_MS);
      }
    };
    // Kick off the first tick a beat after mount so the wallet provider
    // has time to settle.
    timer = setTimeout(loop, 1_500);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [tick]);
}
