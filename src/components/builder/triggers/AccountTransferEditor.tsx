"use client";

import { useState } from "react";
import type { DraftAccountTransfer } from "@/lib/types";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { SpecificOrAnyToggle } from "../SpecificOrAnyToggle";
import { AccountAddressInput } from "../AccountAddressInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function AccountTransferEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftAccountTransfer;
  onChange: (next: DraftAccountTransfer) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <TokenPicker
        title="Watch which token"
        selected={draft.token.mode === "specific" ? draft.token.value : null}
        onBack={() => setPicking(false)}
        onSelect={(token) => {
          onChange({ ...draft, token: { mode: "specific", value: token } });
          setPicking(false);
        }}
      />
    );
  }

  const ready =
    !!draft.account &&
    (draft.token.mode === "any" || draft.token.value != null);

  return (
    <EditorShell title="When this address transfers" side="if" onBack={onBack} onConfirm={onConfirm} ready={ready}>
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
    </EditorShell>
  );
}
