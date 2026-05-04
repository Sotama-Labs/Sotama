"use client";

import { useState } from "react";
import type { DraftSellFor } from "@/lib/types";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { EditorShell, FieldRow } from "../EditorShell";

export function SellForEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftSellFor;
  onChange: (next: DraftSellFor) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [picking, setPicking] = useState(false);

  if (picking) {
    return (
      <TokenPicker
        title="Sell reward for"
        selected={draft.outputToken}
        onBack={() => setPicking(false)}
        onSelect={(token) => {
          onChange({ ...draft, outputToken: token });
          setPicking(false);
        }}
      />
    );
  }

  const ready = draft.outputToken != null;

  return (
    <EditorShell title="Sell reward for" side="then" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      <FieldRow label="Output token">
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
    </EditorShell>
  );
}
