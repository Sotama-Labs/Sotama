"use client";

import type { DraftRestake } from "@/lib/types";
import { AddressInput } from "../AddressInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function RestakeEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftRestake;
  onChange: (next: DraftRestake) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = !!draft.stakeAccount && !!draft.voteAccount;
  return (
    <EditorShell
      title="Restake the reward"
      side="then"
      onBack={onBack}
      onConfirm={onConfirm}
      ready={ready}
      confirmLabel="Confirm"
    >
      <FieldRow label="Stake account">
        <AddressInput
          value={draft.stakeAccount}
          onChange={(v) => onChange({ ...draft, stakeAccount: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>
      <FieldRow label="Vote account">
        <AddressInput
          value={draft.voteAccount}
          onChange={(v) => onChange({ ...draft, voteAccount: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>
      <div
        className="hig-caption-1"
        style={{ color: "var(--label-secondary)", padding: "0.25rem 0.125rem" }}
      >
        The full balance is re-delegated each time the trigger fires —
        accrued rewards become active stake on the next epoch.
      </div>
    </EditorShell>
  );
}
