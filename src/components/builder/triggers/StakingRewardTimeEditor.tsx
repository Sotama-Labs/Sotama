"use client";

import type { DraftStakingRewardTime } from "@/lib/types";
import { AmountInput } from "../AmountInput";
import { AddressInput } from "../AddressInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function StakingRewardTimeEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftStakingRewardTime;
  onChange: (next: DraftStakingRewardTime) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready =
    !!draft.stakeAccount &&
    draft.intervalDays != null &&
    draft.intervalDays > 0;
  return (
    <EditorShell title="Every N days of staking" side="if" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      <FieldRow label="Stake account">
        <AddressInput
          value={draft.stakeAccount}
          onChange={(v) => onChange({ ...draft, stakeAccount: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>
      <FieldRow label="Interval (days)">
        <AmountInput
          value={draft.intervalDays}
          token={null}
          unit="days"
          unitSingular="day"
          presets={[1, 7, 14, 30]}
          onChange={(v) => onChange({ ...draft, intervalDays: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>
    </EditorShell>
  );
}
