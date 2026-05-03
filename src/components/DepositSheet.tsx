"use client";

import { useEffect, useState } from "react";
import type { ActionOption, Slot } from "@/lib/types";
import type { BuilderResult } from "./builder/ConditionalBuilder";
import { Spinner } from "./icons";

const SOLANA_NETWORK_FEE_SOL = 0.000045;
const PROTOCOL_FEE_BPS = 20;

function fmtNum(n: number | null | undefined, dec = 4): string {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(dec >= 4 ? 4 : 2);
  return n.toFixed(dec);
}

function tokenFor(actionId: ActionOption["id"]): { from: "SOL" | "USDC" } {
  if (actionId === "swap_sol_usdc") return { from: "SOL" };
  if (actionId === "swap_usdc_sol") return { from: "USDC" };
  return { from: "SOL" };
}

function FeeRow({ label, sub, value }: { label: string; sub: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0.625rem 0.875rem",
        borderBottom: "0.5px solid var(--separator)",
      }}
    >
      <div>
        <div className="hig-subheadline" style={{ color: "var(--label-primary)", fontWeight: 500 }}>
          {label}
        </div>
        <div className="hig-caption-1" style={{ color: "var(--label-secondary)", marginTop: "0.0625rem" }}>
          {sub}
        </div>
      </div>
      <div
        className="hig-subheadline"
        style={{ color: "var(--label-primary)", fontWeight: 500, fontFeatureSettings: '"tnum"' }}
      >
        {value}
      </div>
    </div>
  );
}

export function DepositSheet({
  open,
  automation,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  automation: BuilderResult | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirming(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open || !automation) return null;

  const actionsList: Slot<ActionOption>[] = automation.actions?.length
    ? automation.actions
    : [{ choice: automation.thenChoice, value: automation.thenValue } as Slot<ActionOption>];

  const byToken: Record<string, number> = {};
  actionsList.forEach((s) => {
    if (!s.choice) return;
    const tok = tokenFor(s.choice.id).from;
    const amt = parseFloat(String(s.value)) || 0;
    byToken[tok] = (byToken[tok] || 0) + amt;
  });
  const tokens = Object.keys(byToken);

  const primaryToken = tokens.sort((a, b) => byToken[b] - byToken[a])[0] || "SOL";
  const primaryAmount = byToken[primaryToken] || 0;

  const networkFeeSol = SOLANA_NETWORK_FEE_SOL * actionsList.length;
  const protocolFeeByToken: Record<string, number> = {};
  tokens.forEach((t) => {
    protocolFeeByToken[t] = byToken[t] * (PROTOCOL_FEE_BPS / 10000);
  });
  const totalByToken: Record<string, number> = {};
  tokens.forEach((t) => {
    totalByToken[t] = byToken[t] + protocolFeeByToken[t];
  });

  const handleConfirm = async () => {
    setConfirming(true);
    await new Promise((r) => setTimeout(r, 1100));
    onConfirm();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "hig-fade-in 200ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "23.75rem",
          margin: "1rem",
          background: "var(--bg-system)",
          borderRadius: "var(--radius-sheet)",
          border: "0.5px solid var(--separator)",
          boxShadow: "var(--shadow-popover)",
          overflow: "hidden",
          animation: "hig-pop-in 240ms cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        <div style={{ padding: "1.25rem 1.25rem 1rem", textAlign: "center" }}>
          <div className="hig-headline" style={{ marginBottom: "0.25rem" }}>
            Fund automation
          </div>
          <div className="hig-subheadline" style={{ color: "var(--label-secondary)" }}>
            Funds release when the trigger fires.
          </div>
        </div>

        <div style={{ padding: "0.5rem 1.25rem 1.25rem", textAlign: "center" }}>
          <div className="hig-large-title" style={{ color: "var(--label-primary)", fontFeatureSettings: '"tnum"' }}>
            {fmtNum(primaryAmount, 4)}
            <span className="hig-title-2" style={{ color: "var(--label-secondary)", marginLeft: "0.375rem" }}>
              {primaryToken}
            </span>
          </div>
          {tokens.length > 1 && (
            <div className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.25rem" }}>
              + {fmtNum(byToken[tokens.find((t) => t !== primaryToken)!], 4)} {tokens.find((t) => t !== primaryToken)}
            </div>
          )}
        </div>

        <div
          style={{
            margin: "0 1rem 1rem",
            background: "var(--fill-4)",
            border: "0.5px solid var(--separator)",
            borderRadius: "0.625rem",
            overflow: "hidden",
          }}
        >
          {tokens.map((t) => (
            <FeeRow
              key={`dep-${t}`}
              label={tokens.length > 1 ? `Deposit (${t})` : "Deposit"}
              sub="Returned if cancelled"
              value={`${fmtNum(byToken[t], 4)} ${t}`}
            />
          ))}
          {tokens.map((t) => (
            <FeeRow
              key={`fee-${t}`}
              label={tokens.length > 1 ? `Sotama fee (${t})` : "Sotama fee"}
              sub={`${(PROTOCOL_FEE_BPS / 100).toFixed(2)}% of swap`}
              value={`${fmtNum(protocolFeeByToken[t], 4)} ${t}`}
            />
          ))}
          <FeeRow
            label="Network fee"
            sub={actionsList.length > 1 ? `Solana base + priority · ${actionsList.length} swaps` : "Solana base + priority"}
            value={`${networkFeeSol.toFixed(6)} SOL`}
          />
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "0.75rem 0.875rem",
              borderTop: "0.5px solid var(--separator)",
              background: "var(--fill-3)",
            }}
          >
            <span className="hig-headline">Total</span>
            <div style={{ textAlign: "right", fontFeatureSettings: '"tnum"' }}>
              {tokens.map((t) => (
                <div key={`tot-${t}`} className="hig-headline">
                  {fmtNum(totalByToken[t], 4)} {t}
                </div>
              ))}
              <div
                className="hig-caption-1"
                style={{ color: "var(--label-secondary)", marginTop: "0.0625rem" }}
              >
                + {networkFeeSol.toFixed(6)} SOL
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", borderTop: "0.5px solid var(--separator)" }}>
          <button
            onClick={onCancel}
            disabled={confirming}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 400,
              borderRight: "0.5px solid var(--separator)",
              opacity: confirming ? 0.4 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.375rem",
              cursor: confirming ? "wait" : "pointer",
            }}
          >
            {confirming ? (
              <>
                <Spinner /> Confirming…
              </>
            ) : (
              "Deposit"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
