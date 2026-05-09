"use client";

/* ─────────────────────────────────────────────────────────────────────
   Cascade-confirmation modal.

   Shown before a chain-spanning operation (delete, pause, resume) so
   the user understands that toggling/deleting any one rule in a chain
   takes the entire chain with it — single-rule control isn't possible
   for linked rules because the chain's funding path depends on every
   downstream rule existing and being funded.
   ───────────────────────────────────────────────────────────────────── */

import { useEffect } from "react";
import type { Automation } from "@/lib/types";
import { renderActionSentence, renderTriggerSentence } from "./builder/SentenceRenderer";

export type CascadeIntent = "delete" | "pause" | "resume";

export function CascadeConfirmModal({
  open,
  intent,
  rules,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  intent: CascadeIntent;
  rules: Automation[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open || rules.length === 0) return null;

  const sortedRules = [...rules].sort(
    (a, b) => (a.link?.position ?? 0) - (b.link?.position ?? 0),
  );

  const verb = intent === "delete" ? "Delete" : intent === "pause" ? "Pause" : "Resume";
  const consequence =
    intent === "delete"
      ? `All ${rules.length} linked rules will be closed on-chain. Each rule's deposit will be refunded to your wallet (one signature per rule).`
      : intent === "pause"
        ? `All ${rules.length} linked rules will pause together. The chain stops firing until you resume.`
        : `All ${rules.length} linked rules will resume firing.`;

  const danger = intent === "delete";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 320,
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
          maxWidth: "26rem",
          margin: "1rem",
          background: "var(--bg-system)",
          borderRadius: "var(--radius-sheet)",
          border: "0.5px solid var(--separator)",
          boxShadow: "var(--shadow-popover)",
          overflow: "hidden",
          animation: "hig-pop-in 240ms cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        <div style={{ padding: "1.25rem 1.25rem 0.75rem", textAlign: "center" }}>
          <div className="hig-headline" style={{ marginBottom: "0.25rem" }}>
            {verb} chain of {rules.length} rules?
          </div>
          <div className="hig-subheadline" style={{ color: "var(--label-secondary)" }}>
            {consequence}
          </div>
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
          {sortedRules.map((rule, i) => (
            <div
              key={rule.id}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.625rem",
                padding: "0.625rem 0.875rem",
                borderBottom:
                  i === sortedRules.length - 1
                    ? "none"
                    : "0.5px solid var(--separator)",
              }}
            >
              <span
                className="hig-caption-1"
                style={{
                  width: "1.5rem",
                  height: "1.5rem",
                  borderRadius: "999px",
                  background: rule.link?.isHead
                    ? "var(--accent-fill)"
                    : "var(--fill-3)",
                  color: rule.link?.isHead ? "var(--accent)" : "var(--label-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 600,
                  flexShrink: 0,
                  marginTop: "0.0625rem",
                }}
              >
                {(rule.link?.position ?? 0) + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="hig-subheadline"
                  style={{
                    color: "var(--label-primary)",
                    fontWeight: 500,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    fontFeatureSettings: '"tnum"',
                  }}
                >
                  <span style={{ color: "var(--label-secondary)" }}>If </span>
                  {rule.triggers[0] && renderTriggerSentence(rule.triggers[0])}
                  <span style={{ color: "var(--label-secondary)" }}> then </span>
                  {rule.actions[0] && renderActionSentence(rule.actions[0])}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", borderTop: "0.5px solid var(--separator)" }}>
          <button
            onClick={onCancel}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 400,
              borderRight: "0.5px solid var(--separator)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: danger ? "var(--red)" : "var(--accent)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {verb} all
          </button>
        </div>
      </div>
    </div>
  );
}
