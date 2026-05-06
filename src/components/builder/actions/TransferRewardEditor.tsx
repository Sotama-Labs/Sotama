"use client";

import type { DraftTransferReward } from "@/lib/types";
import { AddressInput, rememberDestination } from "../AddressInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function TransferRewardEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftTransferReward;
  onChange: (next: DraftTransferReward) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = !!draft.stakeAccount && !!draft.destination;
  const handleConfirm = () => {
    if (!ready || !draft.destination) return;
    rememberDestination(draft.destination);
    onConfirm();
  };
  return (
    <EditorShell
      title="Transfer reward to"
      side="then"
      onBack={onBack}
      onConfirm={handleConfirm}
      ready={ready}
    >
      <FieldRow label="Stake account">
        <AddressInput
          value={draft.stakeAccount}
          onChange={(v) => onChange({ ...draft, stakeAccount: v })}
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
