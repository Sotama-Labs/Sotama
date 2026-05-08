"use client";

import { useState } from "react";
import type { DraftSwap } from "@/lib/types";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

type Picking = "input" | "output" | null;

export function SwapEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftSwap;
  onChange: (next: DraftSwap) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [picking, setPicking] = useState<Picking>(null);

  // Hooks must run in the same order every render — keep them above
  // any conditional return.
  const ready =
    draft.inputToken != null &&
    draft.outputToken != null &&
    draft.amount != null &&
    draft.amount > 0;

  if (picking === "input") {
    return (
      <TokenPicker
        title="Swap from"
        selected={draft.inputToken}
        exclude={draft.outputToken}
        onBack={() => setPicking(null)}
        onSelect={(token) => {
          onChange({ ...draft, inputToken: token });
          setPicking(null);
        }}
      />
    );
  }
  if (picking === "output") {
    return (
      <TokenPicker
        title="Swap to"
        selected={draft.outputToken}
        exclude={draft.inputToken}
        onBack={() => setPicking(null)}
        onSelect={(token) => {
          onChange({ ...draft, outputToken: token });
          setPicking(null);
        }}
      />
    );
  }

  return (
    <EditorShell title="Swap" side="then" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      <FieldRow label="From">
        <button
          onClick={() => setPicking("input")}
          style={pickerBtn}
        >
          {draft.inputToken ? (
            <TokenPill token={draft.inputToken} />
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick input token…
            </span>
          )}
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            change
          </span>
        </button>
      </FieldRow>

      <FieldRow label="To">
        <button
          onClick={() => setPicking("output")}
          style={pickerBtn}
        >
          {draft.outputToken ? (
            <TokenPill token={draft.outputToken} />
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick output token…
            </span>
          )}
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            change
          </span>
        </button>
      </FieldRow>

      <FieldRow label={`Amount (${draft.inputToken?.symbol ?? "input"})`}>
        <AmountInput
          value={draft.amount}
          token={draft.inputToken}
          unit={draft.inputToken?.symbol}
          onChange={(v) => onChange({ ...draft, amount: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>

      <div
        className="hig-caption-1"
        style={{ color: "var(--label-secondary)", padding: "0.25rem 0.125rem" }}
      >
        Routed through Jupiter at execute time — best price across every
        Solana DEX. The keeper re-quotes on each fire and respects your
        slippage tolerance (default 0.5%).
      </div>
    </EditorShell>
  );
}

const pickerBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.5rem 0.625rem",
  background: "var(--fill-4)",
  border: "0.5px solid var(--separator)",
  borderRadius: "0.5rem",
};
