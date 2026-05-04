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
import { SavedList } from "@/components/SavedList";
import { ActiveStrategiesPage } from "@/components/ActiveStrategiesPage";
import { DepositSheet } from "@/components/DepositSheet";
import { hexToRgba } from "@/lib/format";
import { Plus } from "@/components/icons";

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
  const [showBuilder, setShowBuilder] = useState(true);
  const [pendingDeposit, setPendingDeposit] = useState<BuilderResult | null>(null);
  const [view, setView] = useState<View>("compose");
  const isMobile = useIsMobile();

  useEffect(() => {
    setView(initialView());
    const onHash = () => setView(initialView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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

  const handleDepositConfirm = () => {
    const data = pendingDeposit;
    if (!data) return;
    if (editingId) {
      setAutomations((prev) =>
        prev.map((a) =>
          a.id === editingId
            ? { ...a, ...data, lastCheck: "just now" }
            : a,
        ),
      );
      setEditingId(null);
      setToast("Automation updated");
    } else {
      const newA: Automation = {
        id: `a_${Date.now()}`,
        triggers: data.triggers,
        actions: data.actions,
        running: true,
        runs: 0,
        lastCheck: "just now",
      };
      setAutomations((prev) => [newA, ...prev]);
      setToast("Saved · running (read-only demo)");
    }
    setPendingDeposit(null);
    setShowBuilder(false);
  };

  const handleDepositCancel = () => setPendingDeposit(null);
  const handleToggle = (id: string) =>
    setAutomations((prev) => prev.map((a) => (a.id === id ? { ...a, running: !a.running } : a)));
  const handleDelete = (id: string) => {
    setAutomations((prev) => prev.filter((a) => a.id !== id));
    setToast("Automation deleted");
  };
  const handleNew = () => {
    setEditingId(null);
    setShowBuilder(true);
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
                  : showBuilder
                  ? "Tap a slot to choose."
                  : "Toggle to pause. Tap New to add another."}
              </p>
            </header>

            {showBuilder && (
              <ConditionalBuilder key={editingId ?? "new"} initialState={editingInitial} onSave={handleSave} />
            )}

            {!showBuilder && (
              <button
                onClick={handleNew}
                className="fade-slide hig-headline"
                style={{
                  padding: "0.625rem 1.125rem",
                  background: "var(--accent)",
                  color: "white",
                  borderRadius: "0.625rem",
                  fontWeight: 600,
                  boxShadow: "var(--shadow-1)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.375rem",
                }}
              >
                <Plus size={12} /> New automation
              </button>
            )}

            <SavedList items={automations} onToggle={handleToggle} onDelete={handleDelete} onNew={handleNew} />
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
