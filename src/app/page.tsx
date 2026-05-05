"use client";

import { useEffect, useMemo, useState } from "react";
import type { Automation } from "@/lib/types";
import { resolveAppearance, useTweaks } from "@/hooks/useTweaks";
import { BrandMark } from "@/components/BrandMark";
import { WalletPill } from "@/components/WalletPill";
import { AppearanceToggle } from "@/components/AppearanceToggle";
import { SegmentedNav } from "@/components/SegmentedNav";
import { CompactNav } from "@/components/CompactNav";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Toast } from "@/components/Toast";
import { ConditionalBuilder, type BuilderResult } from "@/components/builder/ConditionalBuilder";
import { ActiveStrategiesPage } from "@/components/ActiveStrategiesPage";
import { DepositSheet, type OnChainResult } from "@/components/DepositSheet";
import { hexToRgba } from "@/lib/format";
import {
  loadAutomations,
  makeAutomation,
  saveAutomations,
} from "@/lib/automations";
import { deleteAutomation, submitAutomation } from "@/lib/keeper";
import { useOnChainAutomationSync } from "@/hooks/useOnChainAutomationSync";
import { isTerminal } from "@/lib/types";

type View = "compose" | "active";

function initialView(): View {
  if (typeof window === "undefined") return "compose";
  return window.location.hash === "#active" ? "active" : "compose";
}

export default function Page() {
  const [tweaks, setTweak] = useTweaks();
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  /** Bumped after each successful save so the ConditionalBuilder remounts
   *  with a fresh blank draft instead of keeping the just-saved state. */
  const [composeKey, setComposeKey] = useState(0);
  const [pendingDeposit, setPendingDeposit] = useState<BuilderResult | null>(null);
  const [view, setView] = useState<View>("compose");
  const isMobile = useIsMobile();

  useEffect(() => {
    setAutomations(loadAutomations());
    setView(initialView());
    const onHash = () => setView(initialView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    saveAutomations(automations);
  }, [automations]);

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

  const handleSave = (data: BuilderResult) => setPendingDeposit(data);

  const handleDepositConfirm = async (result: OnChainResult | null) => {
    const data = pendingDeposit;
    if (!data) return;

    const id = editingId ?? undefined;
    const auto = makeAutomation(
      data.triggers,
      data.actions,
      data.triggerOperators,
      data.actionOperators,
      {
        id,
        running: true,
        runs: editingId ? undefined : 0,
        lastCheck: "just now",
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
  const handleToggle = (id: string) =>
    setAutomations((prev) =>
      prev.map((a) => {
        if (a.id !== id) return a;
        // Terminal automations (executed or closed on-chain) cannot resume.
        if (isTerminal(a)) return a;
        return { ...a, running: !a.running };
      }),
    );

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

  const handleDelete = async (id: string) => {
    setAutomations((prev) => prev.filter((a) => a.id !== id));
    try {
      await deleteAutomation(id);
    } catch {
      // local removal succeeded; backend will reconcile
    }
    setToast("Automation deleted");
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

            <ConditionalBuilder
              key={editingId ?? `new-${composeKey}`}
              initialState={editingInitial}
              onSave={handleSave}
            />
          </>
        ) : (
          <ActiveStrategiesPage
            automations={automations}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        )}
      </main>

      <Toast message={toast} />
      <DepositSheet open={!!pendingDeposit} automation={pendingDeposit} onCancel={handleDepositCancel} onConfirm={handleDepositConfirm} />
    </>
  );
}
