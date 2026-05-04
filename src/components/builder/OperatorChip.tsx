"use client";

import { useState } from "react";

/* ─────────────────────────────────────────────────────────────────────
   Inline operator chip used between trigger / action slots.
   Click to toggle between two operator options. Sentence-styled — sits
   inline with surrounding text.
   ───────────────────────────────────────────────────────────────────── */

export function OperatorChip<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly [T, T];
  onChange: (next: T) => void;
}) {
  const [hover, setHover] = useState(false);
  const next = value === options[0] ? options[1] : options[0];
  return (
    <button
      onClick={() => onChange(next)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`Switch to ${next.toUpperCase()}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "0.125rem 0.5rem",
        borderRadius: "0.375rem",
        background: hover ? "var(--fill-3)" : "transparent",
        color: "var(--label-secondary)",
        fontSize: "inherit",
        fontFamily: "inherit",
        fontWeight: 400,
        letterSpacing: "inherit",
        transition: "background 120ms, color 120ms",
        cursor: "pointer",
      }}
    >
      {value}
    </button>
  );
}
