"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Automation } from "@/lib/types";
import { resolveAppearance, useTweaks } from "@/hooks/useTweaks";
import { BrandMark } from "@/components/BrandMark";
import { WalletPill } from "@/components/WalletPill";
import { AppearanceToggle } from "@/components/AppearanceToggle";
import { SegmentedNav } from "@/components/SegmentedNav";
import { CompactNav } from "@/components/CompactNav";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Toast } from "@/components/Toast";
import { CascadeConfirmModal } from "@/components/CascadeConfirmModal";
import { type BuilderResult } from "@/lib/types";
import { LinkedChainBuilder, type ChainSaveData } from "@/components/builder/LinkedChainBuilder";
import { ActiveStrategiesPage } from "@/components/ActiveStrategiesPage";
import { DepositSheet, type OnChainResult } from "@/components/DepositSheet";
import { ChainDepositSheet, type ChainOnChainResult } from "@/components/ChainDepositSheet";
import { hexToRgba } from "@/lib/format";
import {
  loadAutomations,
  makeAutomation,
  newAutomationId,
  saveAutomations,
} from "@/lib/automations";
import {
  fetchOwnedOnChainAutomations,
  mergeOnChainAutomations,
} from "@/lib/on-chain-automations";
import { deleteAutomation, submitAutomation } from "@/lib/keeper";
import { useOnChainAutomationSync } from "@/hooks/useOnChainAutomationSync";
import { isTerminal } from "@/lib/types";
import { closeAutomationOnChain, OrphanedAutomationError } from "@/lib/close-automation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";

type View = "compose" | "active";

function initialView(): View {
  if (typeof window === "undefined") return "compose";
  return window.location.hash === "#active" ? "active" : "compose";
}

export function AutomationWorkspace() {
  const [tweaks, setTweak] = useTweaks();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  const [automationsOwner, setAutomationsOwner] = useState<string | null>(null);
  const [hydratingOnChain, setHydratingOnChain] = useState(false);
  /** Bumped after each successful save so the ConditionalBuilder remounts
   *  with a fresh blank draft instead of keeping the just-saved state. */
  const [composeKey, setComposeKey] = useState(0);
  const [pendingDeposit, setPendingDeposit] = useState<BuilderResult | null>(null);
  /** When the user saves a 2-3 rule linked chain, route through the
   *  ChainDepositSheet so the atomic multi-create tx is signed in one
   *  click. */
  const [pendingChainDeposit, setPendingChainDeposit] = useState<ChainSaveData | null>(null);
  /** When the user clicks delete or pause on a chained rule, surface
   *  a cascade-confirmation modal listing every sibling that will be
   *  affected. Set to null when no cascade is pending. */
  const [pendingCascade, setPendingCascade] = useState<{
    intent: "delete" | "pause" | "resume";
    targetId: string;
    siblingIds: string[];
  } | null>(null);
  const [view, setView] = useState<View>("compose");
  const isMobile = useIsMobile();
  const { connection } = useConnection();
  const wallet = useWallet();
  const walletPublicKey = wallet.publicKey;

  /** Local strategies are scoped per connected wallet so wallet B
   *  doesn't see wallet A's saved automations. Reload whenever the
   *  connected pubkey changes (connect / disconnect / switch). */
  const walletOwner = wallet.publicKey?.toBase58() ?? null;
  useEffect(() => {
    let cancelled = false;
    const local = loadAutomations(walletOwner);
    setAutomationsOwner(walletOwner);
    setAutomations(local);

    if (!walletPublicKey) {
      setHydratingOnChain(false);
      return () => {
        cancelled = true;
      };
    }

    setHydratingOnChain(true);
    fetchOwnedOnChainAutomations(connection, walletPublicKey)
      .then((remote) => {
        if (cancelled) return;
        setAutomations((prev) => mergeOnChainAutomations(prev, remote));
      })
      .catch((e) => {
        if (!cancelled) console.warn("on-chain automation hydration failed:", e);
      })
      .finally(() => {
        if (!cancelled) setHydratingOnChain(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connection, walletOwner, walletPublicKey]);

  useEffect(() => {
    setView(initialView());
    const onHash = () => setView(initialView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (automationsOwner !== walletOwner) return;
    saveAutomations(walletOwner, automations);
  }, [walletOwner, automationsOwner, automations]);

  useEffect(() => {
    const wanted = view === "active" ? "#active" : "#compose";
    if (window.location.hash !== wanted) window.history.replaceState(null, "", wanted);
  }, [view]);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-appearance", resolveAppearance(tweaks.appearance));
    const fill = tweaks.accent && tweaks.accent.toUpperCase() !== "#007AFF"
      ? hexToRgba(tweaks.accent, 0.15)
      : null;
    if (fill) {
      root.style.setProperty("--accent", tweaks.accent);
      root.style.setProperty("--accent-fill", fill);
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-fill");
    }
  }, [tweaks.appearance, tweaks.accent]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(""), 2200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const handleSave = (data: BuilderResult) => {
    // The standalone builder only produces once-cadence rules (loops are
    // expressed via the LinkedChainBuilder), so there's nothing to tune
    // between save and deposit.
    setPendingDeposit(data);
  };

  const handleSaveChain = (data: ChainSaveData) => {
    setPendingChainDeposit(data);
  };

  const handleChainDepositCancel = () => setPendingChainDeposit(null);

  const handleChainDepositConfirm = async (result: ChainOnChainResult | null) => {
    const chain = pendingChainDeposit;
    if (!chain) return;
    if (!result) {
      setPendingChainDeposit(null);
      return;
    }

    const chainId = `chain_${newAutomationId().slice(2)}`;
    const total = chain.nodes.length;
    // Resolve the cadence each rule was created with on-chain. When a
    // loopMode was set, sendChainCreate overrode every rule's cadence
    // with the loop template — mirror that on the saved record so the
    // local store agrees with on-chain state.
    const effectiveCadence = (n: { result: { cadence: import("@/lib/types").Cadence } }) =>
      chain.loopMode
        ? chain.loopMode.kind === "frequency"
          ? ({ kind: "repeat", total: chain.loopMode.cycles } as const)
          : ({
              kind: "until",
              unixDeadline: 4_102_444_800,
            } as const)
        : n.result.cadence;
    // First pass: build the Automation records WITHOUT linkedDownstream
    // wiring — we need the ids to resolve the link metadata below.
    const created = chain.nodes.map((node, i) => {
      // Mirror the on-chain `Swap.linked_downstream` onto the JS-side
      // action so the Jupiter trigger router classifies this as a
      // "keeper rule" (linkedDownstream presence forces the keeper
      // path — see jupiter-trigger-router.ts:87). The pubkey here is
      // the downstream rule's PDA, not its UI id; the router only
      // checks for presence, not value. We patch `actions[0]` of
      // every chain rule whose `next` is non-null.
      // Resolve the downstream rule's on-chain pubkey for whatever
      // index the link points at. Forward auto-links and back-links
      // share the same shape now — both `rule` with a ruleIndex.
      const downstreamPubkey = node.next
        ? result.nodes[node.next.ruleIndex]?.pubkey
        : undefined;
      const patchedActions = node.result.actions.map((a, ai) =>
        ai === 0 && a.kind === "swap" && downstreamPubkey
          ? { ...a, linkedDownstream: downstreamPubkey }
          : a,
      );
      const auto = makeAutomation(
        node.result.triggers,
        patchedActions,
        node.result.triggerOperators,
        node.result.actionOperators,
        effectiveCadence(node),
        node.result.minIntervalSecs,
        {
          running: true,
          runs: 0,
          pubkey: result.nodes[i]?.pubkey,
          signature: result.signature,
          nonce: result.nodes[i]?.nonce,
        },
      );
      return { node, auto };
    });

    // Now wire up `link` metadata across the freshly minted ids.
    // Persisted ChainLinkTarget keeps the `loopBack` variant for
    // backward-compat reads of older localStorage entries; new writes
    // always use `rule` with the resolved sibling rule id.
    const finalAutomations = created.map(({ node, auto }, i) => {
      let nextLink = null as
        | null
        | { kind: "rule"; ruleId: string }
        | { kind: "loopBack" };
      if (node.next) {
        const targetId = created[node.next.ruleIndex]?.auto.id;
        if (targetId) nextLink = { kind: "rule", ruleId: targetId };
      }
      return {
        ...auto,
        link: {
          chainId,
          position: i,
          total,
          next: nextLink,
          isHead: i === 0,
        },
      };
    });

    // Sidecar API best-effort — failures here don't roll back the
    // on-chain creates.
    for (const auto of finalAutomations) {
      try {
        await submitAutomation(auto);
      } catch (e) {
        const err = e as Error;
        console.warn("submitAutomation sidecar failed:", err.message);
      }
    }

    setAutomations((prev) => [...finalAutomations, ...prev]);
    setToast(
      `Chain funded · ${result.signature.slice(0, 8)}… · ${total} rules`,
    );
    setPendingChainDeposit(null);
    setComposeKey((n) => n + 1);
  };

  const handleDepositConfirm = async (result: OnChainResult | null) => {
    const data = pendingDeposit;
    if (!data) return;

    const id = editingId ?? undefined;
    const auto = makeAutomation(
      data.triggers,
      data.actions,
      data.triggerOperators,
      data.actionOperators,
      data.cadence,
      data.minIntervalSecs,
      {
        id,
        running: true,
        runs: editingId ? undefined : 0,
        pubkey: result?.pubkey,
        signature: result?.signature,
        nonce: result?.nonce,
      },
    );

    try {
      await submitAutomation(auto);
    } catch (e) {
      const err = e as Error;
      // Sidecar API failure shouldn't undo a successful on-chain create.
      console.warn("submitAutomation sidecar failed:", err.message);
    }

    if (editingId) {
      setAutomations((prev) =>
        prev.map((a) => (a.id === editingId ? auto : a)),
      );
      setEditingId(null);
      setToast(result ? "Automation funded on-chain" : "Automation updated");
    } else {
      setAutomations((prev) => [auto, ...prev]);
      setToast(
        result
          ? `Funded · ${result.signature.slice(0, 8)}…`
          : "Saved · pending on-chain support",
      );
    }

    setPendingDeposit(null);
    setComposeKey((n) => n + 1);
  };

  const handleDepositCancel = () => setPendingDeposit(null);

  /** Return every Automation that's part of the same chain as `id`,
   *  including `id` itself. Returns just `[id]` for non-chained rules. */
  const chainSiblings = useCallback(
    (id: string): string[] => {
      const target = automations.find((a) => a.id === id);
      if (!target?.link?.chainId) return [id];
      const chainId = target.link.chainId;
      return automations
        .filter((a) => a.link?.chainId === chainId)
        .map((a) => a.id);
    },
    [automations],
  );

  const togglePure = (id: string) =>
    setAutomations((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        if (isTerminal(a)) return a;
        return { ...a, running: !a.running };
      }),
    );

  const togglePureMany = (ids: Set<string>, nextRunning: boolean) =>
    setAutomations((prev) =>
      prev.map((a) => {
        if (!ids.has(a.id)) return a;
        if (isTerminal(a)) return a;
        return { ...a, running: nextRunning };
      }),
    );

  const handleToggle = (id: string) => {
    const target = automations.find((a) => a.id === id);
    if (!target) return;
    const siblings = chainSiblings(id);
    // Standalone rules toggle in-place.
    if (siblings.length <= 1) {
      togglePure(id);
      return;
    }
    setPendingCascade({
      intent: target.running ? "pause" : "resume",
      targetId: id,
      siblingIds: siblings,
    });
  };

  const patchAutomation = (id: string, partial: Partial<Automation>) =>
    setAutomations((prev) => {
      let mutated = false;
      const next = prev.map((a) => {
        if (a.id !== id) return a;
        // Only patch if at least one field actually changes — keeps React
        // from re-rendering the whole list every poll.
        const merged = { ...a, ...partial };
        if (
          merged.executedAt !== a.executedAt ||
          merged.closedAt !== a.closedAt ||
          merged.running !== a.running ||
          merged.runs !== a.runs ||
          merged.lastCheck !== a.lastCheck
        ) {
          mutated = true;
          return merged;
        }
        return a;
      });
      return mutated ? next : prev;
    });

  useOnChainAutomationSync(automations, patchAutomation);

  /** Close one rule on-chain (refund deposit) and preserve it in local
   *  state as terminal/closed history. Returns true if the close
   *  succeeded (or wasn't needed); false on error. The error surface
   *  lives in the calling cascade so partial failures can be reported
   *  without losing already-closed siblings.
   *
   *  Two paths:
   *  1. Live rule (pubkey set, closedAt unset): close on chain, then
   *     mark the record `closedAt + running:false`. Record stays in
   *     localStorage so the user can see their completed/closed history
   *     in Active Strategies, even after no active rule is running.
   *  2. Already-terminal record (closedAt set, or never funded): treat
   *     as a local-only "Remove" — fully drop from state. This is the
   *     hover-only "Remove" affordance on terminal rows.
   *
   *  Prior behavior unconditionally `filter`-removed on success, which
   *  meant "Close & collect" on a fired rule would erase its history
   *  from the UI the moment the refund tx landed. */
  const closeOneRule = useCallback(
    async (id: string): Promise<boolean> => {
      const target = automations.find((a) => a.id === id);
      if (!target) return true;
      if (target.pubkey && !target.closedAt) {
        if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
          setToast("Connect wallet to close on-chain and refund deposit");
          return false;
        }
        try {
          await closeAutomationOnChain(
            connection,
            {
              publicKey: wallet.publicKey,
              signTransaction: wallet.signTransaction,
            },
            target,
          );
        } catch (e) {
          if (e instanceof OrphanedAutomationError) {
            // PDA belongs to a previous program ID (devnet rotation
            // orphaned this record). The local record references a
            // dead program — fully drop it (no point preserving
            // unactionable history). Deposit, if any, is recoverable
            // only by closing against the prior program.
            console.warn(
              "automation orphaned by program rotation; removing locally",
              id,
              e.actualOwner,
            );
            setToast(
              "Removed stale rule from prior program version — funds (if any) require manual recovery",
            );
            setAutomations((prev) => prev.filter((a) => a.id !== id));
            try {
              await deleteAutomation(id);
            } catch {
              // local removal succeeded; backend will reconcile
            }
            return true;
          }
          const msg = (e as Error).message || "close failed";
          console.error("close_automation failed", id, e);
          setToast(`Close tx failed: ${msg.slice(0, 80)}`);
          return false;
        }
        // On-chain close succeeded — keep the record as terminal history.
        const now = new Date().toISOString();
        setAutomations((prev) =>
          prev.map((a) =>
            a.id === id ? { ...a, closedAt: now, running: false } : a,
          ),
        );
        try {
          await deleteAutomation(id);
        } catch {
          // local state already patched; backend will reconcile
        }
        return true;
      }
      // Already terminal (closedAt set OR never on chain) — explicit
      // local-only remove. This is the hover-only "Remove" button on
      // terminal rows in SavedList / ActiveStrategiesPage.
      setAutomations((prev) => prev.filter((a) => a.id !== id));
      try {
        await deleteAutomation(id);
      } catch {
        // local removal succeeded; backend will reconcile
      }
      return true;
    },
    [automations, connection, wallet],
  );

  const handleDelete = async (id: string) => {
    const siblings = chainSiblings(id);
    if (siblings.length <= 1) {
      // Standalone rule — close + refund + remove.
      const ok = await closeOneRule(id);
      if (ok) {
        const target = automations.find((a) => a.id === id);
        setToast(
          target?.pubkey && !target.closedAt
            ? "Automation closed and deposit refunded"
            : "Automation deleted",
        );
      }
      return;
    }
    setPendingCascade({ intent: "delete", targetId: id, siblingIds: siblings });
  };

  const executeCascade = async () => {
    const cascade = pendingCascade;
    if (!cascade) return;
    setPendingCascade(null);
    if (cascade.intent === "delete") {
      // Close each rule sequentially. Each close needs its own wallet
      // signature — the user gives consent once via the modal, then
      // signs as many txs as there are funded rules (typically 2-3).
      let okCount = 0;
      for (const sid of cascade.siblingIds) {
        const ok = await closeOneRule(sid);
        if (ok) okCount += 1;
      }
      setToast(
        okCount === cascade.siblingIds.length
          ? `Chain closed · ${okCount} rules refunded`
          : `Chain partially closed (${okCount}/${cascade.siblingIds.length}) — see console`,
      );
      return;
    }
    // Pause/resume cascade — purely UI-side flag, no on-chain ix.
    const nextRunning = cascade.intent === "resume";
    togglePureMany(new Set(cascade.siblingIds), nextRunning);
    setToast(
      nextRunning
        ? `Resumed ${cascade.siblingIds.length}-rule chain`
        : `Paused ${cascade.siblingIds.length}-rule chain`,
    );
  };

  const editingInitial = useMemo(() => {
    if (!editingId) return null;
    return automations.find((a) => a.id === editingId) ?? null;
  }, [editingId, automations]);

  return (
    <>
      <BrandMark />
      <div
        style={{
          position: "fixed",
          top: "1rem",
          right: "1rem",
          zIndex: 5,
          display: "flex",
          alignItems: "center",
          gap: "0.625rem",
        }}
      >
        <AppearanceToggle appearance={tweaks.appearance} onChange={(v) => setTweak("appearance", v)} />
        <WalletPill />
      </div>

      <div style={{ position: "fixed", top: "1rem", left: "50%", transform: "translateX(-50%)", zIndex: 5 }}>
        {isMobile ? (
          <CompactNav<View>
            value={view}
            onChange={setView}
            options={[
              { value: "compose", label: "Compose" },
              { value: "active", label: "Active" },
            ]}
          />
        ) : (
          <SegmentedNav<View>
            value={view}
            onChange={setView}
            options={[
              { value: "compose", label: "Compose" },
              { value: "active", label: "Active Strategies" },
            ]}
          />
        )}
      </div>

      <main
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: view === "compose" ? "center" : "flex-start",
          padding: "6rem 1.5rem 7.5rem",
        }}
      >
        {view === "compose" ? (
          <>
            <header
              style={{
                width: "100%",
                maxWidth: "45rem",
                marginBottom: "1.75rem",
                textAlign: "center",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
              }}
            >
              <p className="hig-body" style={{ color: "var(--label-secondary)", margin: 0, textWrap: "pretty" }}>
                {automations.length === 0
                  ? "Compose a single-sentence rule. Sotama runs it on auto mode."
                  : "Tap a slot to choose. Saved automations live in Active Strategies."}
              </p>
            </header>

            <LinkedChainBuilder
              key={editingId ?? `new-${composeKey}`}
              initialState={editingInitial}
              onSaveSingle={handleSave}
              onSaveChain={handleSaveChain}
            />
          </>
        ) : (
          <ActiveStrategiesPage
            automations={automations}
            onToggle={handleToggle}
            onDelete={handleDelete}
            loading={hydratingOnChain}
          />
        )}
      </main>

      <Toast message={toast} />
      <DepositSheet open={!!pendingDeposit} automation={pendingDeposit} onCancel={handleDepositCancel} onConfirm={handleDepositConfirm} />
      <ChainDepositSheet
        open={!!pendingChainDeposit}
        nodes={pendingChainDeposit?.nodes ?? null}
        loopMode={pendingChainDeposit?.loopMode ?? null}
        onCancel={handleChainDepositCancel}
        onConfirm={handleChainDepositConfirm}
      />
      <CascadeConfirmModal
        open={!!pendingCascade}
        intent={pendingCascade?.intent ?? "delete"}
        rules={
          pendingCascade
            ? pendingCascade.siblingIds
                .map((sid) => automations.find((a) => a.id === sid))
                .filter((a): a is Automation => !!a)
            : []
        }
        onCancel={() => setPendingCascade(null)}
        onConfirm={executeCascade}
      />
    </>
  );
}
