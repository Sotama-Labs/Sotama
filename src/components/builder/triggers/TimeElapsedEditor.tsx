"use client";

import {
  UI_MAX_TIME_ELAPSED_BY_UNIT,
  clampTimeElapsed,
  type DraftTimeElapsed,
  type TimeElapsedUnit,
} from "@/lib/types";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

const UNIT_OPTIONS: { value: TimeElapsedUnit; label: string }[] = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
];

const PRESETS_BY_UNIT: Record<TimeElapsedUnit, number[]> = {
  minutes: [5, 15, 30, 60],
  hours: [1, 4, 12, 24],
  days: [1, 7, 14, 30],
};

const SINGULAR: Record<TimeElapsedUnit, string> = {
  minutes: "minute",
  hours: "hour",
  days: "day",
};

export function TimeElapsedEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftTimeElapsed;
  onChange: (next: DraftTimeElapsed) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const ready = draft.value != null && draft.value > 0;

  return (
    <EditorShell
      title="When this much time has passed"
      side="if"
      onBack={onBack}
      onConfirm={onConfirm}
      ready={ready}
    >
      <FieldRow label="Duration">
        <AmountInput
          value={draft.value}
          token={null}
          presets={PRESETS_BY_UNIT[draft.unit]}
          unit={draft.unit}
          unitSingular={SINGULAR[draft.unit]}
          onChange={(v) => onChange({ ...draft, value: clampTimeElapsed(v, draft.unit) })}
          onCommit={ready ? onConfirm : undefined}
          placeholder="0"
        />
      </FieldRow>

      <FieldRow label="Unit">
        <div
          style={{
            display: "flex",
            gap: "0.25rem",
            background: "var(--fill-4)",
            borderRadius: "0.5rem",
            padding: "0.125rem",
            border: "0.5px solid var(--separator)",
          }}
        >
          {UNIT_OPTIONS.map((opt) => {
            const active = draft.unit === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => onChange({
                  ...draft,
                  unit: opt.value,
                  value: clampTimeElapsed(draft.value, opt.value),
                })}
                className="hig-footnote"
                style={{
                  flex: 1,
                  padding: "0.375rem 0.5rem",
                  borderRadius: "0.375rem",
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "white" : "var(--label-secondary)",
                  fontWeight: active ? 600 : 500,
                  transition: "background 120ms, color 120ms",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </FieldRow>

      {draft.value != null && draft.value === UI_MAX_TIME_ELAPSED_BY_UNIT[draft.unit] && (
        <div
          className="hig-caption-1"
          style={{ color: "var(--label-tertiary)", padding: "0.25rem 0.125rem" }}
        >
          Capped at 30 days. Use a longer cadence by chaining rules.
        </div>
      )}
    </EditorShell>
  );
}
