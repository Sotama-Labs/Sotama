"use client";

import type { DraftPriceRelativeToFill } from "@/lib/types";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function PriceRelativeToFillEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftPriceRelativeToFill;
  onChange: (next: DraftPriceRelativeToFill) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = draft.pctBps != null && draft.pctBps > 0;

  // Convert between displayed percent and stored basis points.
  // pctBps=500 → displayed "5", pctBps=100 → "1"
  const displayPct = draft.pctBps != null ? draft.pctBps / 100 : null;

  const handlePctChange = (v: number | null) => {
    onChange({ ...draft, pctBps: v != null ? Math.round(v * 100) : null });
  };

  return (
    <EditorShell title="Relative to upstream fill" side="if" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      {/* Upstream context caption */}
      <div
        className="hig-caption-1"
        style={{
          color: "var(--label-secondary)",
          padding: "0.5rem 0.625rem",
          background: "var(--fill-4)",
          borderRadius: "0.5rem",
          border: "0.5px solid var(--separator)",
          lineHeight: 1.5,
        }}
      >
        Fires when this rule&apos;s input token price has moved the set percentage
        from the effective fill price of the upstream rule. The upstream rule is
        resolved at chain-build time.
      </div>

      <FieldRow label="Direction">
        <div
          style={{
            display: "inline-flex",
            padding: "0.125rem",
            background: "var(--fill-3)",
            borderRadius: "0.5rem",
            gap: "0.125rem",
            width: "fit-content",
          }}
        >
          {(["grow", "drop"] as const).map((d) => {
            const sel = draft.direction === d;
            return (
              <button
                key={d}
                onClick={() => onChange({ ...draft, direction: d })}
                className="hig-footnote"
                style={{
                  padding: "0.25rem 0.75rem",
                  borderRadius: "0.375rem",
                  background: sel ? "var(--bg-system)" : "transparent",
                  color: sel ? "var(--label-primary)" : "var(--label-secondary)",
                  fontWeight: 500,
                  boxShadow: sel ? "var(--shadow-1)" : "none",
                  transition: "background 120ms",
                }}
              >
                {d === "grow" ? "Grew above fill" : "Dropped below fill"}
              </button>
            );
          })}
        </div>
      </FieldRow>

      <FieldRow label="Movement threshold (%)">
        <AmountInput
          value={displayPct}
          token={null}
          onChange={handlePctChange}
          onCommit={ready ? onConfirm : undefined}
          unit="%"
          placeholder="5"
          presets={[1, 2, 5, 10].map((pct) => ({
            label: `${pct}%`,
            value: pct,
          }))}
        />
        <div
          className="hig-caption-1"
          style={{ color: "var(--label-tertiary)", padding: "0 0.125rem" }}
        >
          {draft.pctBps != null && draft.pctBps > 0
            ? `${draft.pctBps} bps — fires when price has ${draft.direction === "grow" ? "grown" : "dropped"} ${displayPct}% from fill`
            : "Enter a percentage to set the trigger threshold"}
        </div>
      </FieldRow>
    </EditorShell>
  );
}
