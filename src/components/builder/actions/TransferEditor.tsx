"use client";

import { useState } from "react";
import type { DraftTransfer } from "@/lib/types";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { AmountInput } from "../AmountInput";
import { AddressInput, rememberDestination } from "../AddressInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function TransferEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftTransfer;
  onChange: (next: DraftTransfer) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <TokenPicker
        title="Send which token"
        selected={draft.token}
        onBack={() => setPicking(false)}
        onSelect={(token) => {
          onChange({ ...draft, token });
          setPicking(false);
        }}
      />
    );
  }

  const ready =
    draft.token != null &&
    draft.amount != null &&
    draft.amount > 0 &&
    !!draft.destination;

  const handleConfirm = () => {
    if (!ready || !draft.destination) return;
    rememberDestination(draft.destination);
    onConfirm();
  };

  return (
    <EditorShell title="Transfer" side="then" onBack={onBack} onConfirm={handleConfirm} ready={ready}>
      <FieldRow label="Token">
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
          {draft.token ? (
            <TokenPill token={draft.token} />
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick a token…
            </span>
          )}
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            change
          </span>
        </button>
      </FieldRow>

      <FieldRow label="Amount">
        <AmountInput
          value={draft.amount}
          token={draft.token}
          unit={draft.token?.symbol}
          onChange={(v) => onChange({ ...draft, amount: v })}
          onCommit={ready ? handleConfirm : undefined}
        />
      </FieldRow>

      <FieldRow label="Destination">
        <AddressInput
          value={draft.destination}
          onChange={(v) => onChange({ ...draft, destination: v })}
          onCommit={ready ? handleConfirm : undefined}
        />
      </FieldRow>
    </EditorShell>
  );
}
