"use client";

import { EditorShell } from "../EditorShell";

export function RestakeEditor({ onBack, onConfirm }: { onBack: () => void; onConfirm: () => void }) {
  return (
    <EditorShell
      title="Restake the reward"
      side="then"
      onBack={onBack}
      onConfirm={onConfirm}
      ready
      confirmLabel="Confirm"
    >
      <div
        className="hig-caption-1"
        style={{ color: "var(--label-secondary)", padding: "0.25rem 0.125rem" }}
      >
        The full reward is compounded back into the stake account each time the
        trigger fires. No additional parameters.
      </div>
    </EditorShell>
  );
}
