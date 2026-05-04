"use client";

import type { DraftStakingRewardAmount } from "@/lib/types";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

export function StakingRewardAmountEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftStakingRewardAmount;
  onChange: (next: DraftStakingRewardAmount) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = draft.threshold != null && draft.threshold > 0;
  return (
    <EditorShell
      title="Staking reward exceeds"
      side="if"
      onBack={onBack}
      onConfirm={onConfirm}
      ready={ready}
    >
      <FieldRow label="Threshold (SOL)">
        <AmountInput
          value={draft.threshold}
          token={null}
          unit="SOL"
          presets={[0.1, 0.5, 1, 5]}
          onChange={(v) => onChange({ ...draft, threshold: v })}
          onCommit={ready ? onConfirm : undefined}
        />
      </FieldRow>
    </EditorShell>
  );
}
