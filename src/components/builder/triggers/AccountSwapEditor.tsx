"use client";

import { useState } from "react";
import type { DraftAccountSwap } from "@/lib/types";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { SpecificOrAnyToggle } from "../SpecificOrAnyToggle";
import { AmountInput } from "../AmountInput";
import { AccountAddressInput } from "../AccountAddressInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function AccountSwapEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftAccountSwap;
  onChange: (next: DraftAccountSwap) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <TokenPicker
        title="Which token swap"
        selected={draft.token.mode === "specific" ? draft.token.value : null}
        onBack={() => setPicking(false)}
        onSelect={(token) => {
          onChange({ ...draft, token: { mode: "specific", value: token } });
          setPicking(false);
        }}
      />
    );
  }

  const tokenReady = draft.token.mode === "any" || draft.token.value != null;
  const amountReady =
    draft.amount.mode === "any" || (draft.amount.value != null && draft.amount.value > 0);
  const ready = !!draft.account && tokenReady && amountReady;

  return (
    <EditorShell title="When this address swaps" side="if" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      <FieldRow label="Address">
        <AccountAddressInput
          value={draft.account}
          onChange={(v) => onChange({ ...draft, account: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>

      <FieldRow label="Token">
        <SpecificOrAnyToggle
          mode={draft.token.mode}
          onChange={(next) => {
            if (next === "any") onChange({ ...draft, token: { mode: "any" } });
            else onChange({ ...draft, token: { mode: "specific", value: null } });
          }}
        />
      </FieldRow>
      {draft.token.mode === "specific" && (
        <button
          onClick={() => setPicking(true)}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.5rem 0.625rem",
            background: "var(--fill-4)",
            border: "0.5px solid var(--separator)",
            borderRadius: "0.5rem",
          }}
        >
          {draft.token.value ? (
            <TokenPill token={draft.token.value} />
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick a token…
            </span>
          )}
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            change
          </span>
        </button>
      )}

      <FieldRow label="Amount">
        <SpecificOrAnyToggle
          mode={draft.amount.mode}
          onChange={(next) => {
            if (next === "any") onChange({ ...draft, amount: { mode: "any" } });
            else onChange({ ...draft, amount: { mode: "specific", value: null } });
          }}
        />
      </FieldRow>
      {draft.amount.mode === "specific" && (
        <AmountInput
          value={draft.amount.value ?? null}
          token={draft.token.mode === "specific" ? draft.token.value : null}
          unit={draft.token.mode === "specific" ? draft.token.value?.symbol : "tokens"}
          onChange={(v) => onChange({ ...draft, amount: { mode: "specific", value: v } })}
          onCommit={ready ? onConfirm : undefined}
        />
      )}
    </EditorShell>
  );
}
