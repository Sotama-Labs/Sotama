"use client";

import { createRef, useState, type RefObject } from "react";
import type { Cadence, CadenceKind } from "@/lib/types";
import { Popover } from "./Popover";

/* ─────────────────────────────────────────────────────────────────────
   Lead-word chip on the trigger row. Cycles between If / While / For,
   determining the cadence semantics:
     If    → fire once when triggered                    (Cadence.Once)
     While → fire repeatedly until a deadline            (Cadence.Until)
     For   → fire a fixed number of times                (Cadence.Repeat)

   When the user picks While or For, we seed sensible default values
   (deadline 24h out / total = 3) so the tail chip is immediately valid.
   ───────────────────────────────────────────────────────────────────── */

const ONE_DAY_SECS = 24 * 60 * 60;
const DEFAULT_REPEAT_TOTAL = 3;

// Lead-word labels are tuned to read naturally with the trigger that
// follows them, since they're now the only cadence cue in the sentence:
//   • "If price drops below $103"        — event/condition
//   • "While price is below $103"        — standing predicate
//   • "Each time SOL is transferred"     — counted recurrence
const LABELS: Record<CadenceKind, string> = {
  once: "If",
  until: "While",
  repeat: "Each time",
};

const DESCRIPTIONS: Record<CadenceKind, string> = {
  once: "Run one time when the trigger is met.",
  until: "Run repeatedly until a deadline.",
  repeat: "Run a fixed number of times.",
};

const ORDER: CadenceKind[] = ["once", "until", "repeat"];

export function ControlFlowChip({
  cadence,
  onChange,
}: {
  cadence: Cadence;
  onChange: (next: Cadence) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const anchorRef = createRef<HTMLButtonElement>() as RefObject<HTMLButtonElement>;

  const pickKind = (kind: CadenceKind) => {
    if (kind === cadence.kind) {
      setOpen(false);
      return;
    }
    if (kind === "once") onChange({ kind: "once" });
    else if (kind === "until")
      onChange({
        kind: "until",
        unixDeadline: Math.floor(Date.now() / 1000) + ONE_DAY_SECS,
      });
    else onChange({ kind: "repeat", total: DEFAULT_REPEAT_TOTAL });
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title={`Control: ${LABELS[cadence.kind]}`}
        aria-label={`Control flow: ${LABELS[cadence.kind]}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: "0.125rem 0.375rem",
          margin: "0 -0.375rem",
          borderRadius: "0.375rem",
          background: open || hover ? "var(--fill-3)" : "transparent",
          color: "var(--label-secondary)",
          fontSize: "inherit",
          fontFamily: "inherit",
          fontWeight: 400,
          letterSpacing: "inherit",
          transition: "background 120ms",
          cursor: "pointer",
        }}
      >
        {LABELS[cadence.kind]}
      </button>
      <Popover
        anchorRef={anchorRef}
        open={open}
        onClose={() => setOpen(false)}
        width={300}
        align="start"
      >
        <div className="fade-slide" style={{ padding: "0.5rem 0" }}>
          <div
            className="hig-caption-1"
            style={{
              padding: "0.25rem 1rem 0.5rem",
              color: "var(--label-tertiary)",
            }}
          >
            Control flow
          </div>
          {ORDER.map((kind) => {
            const selected = kind === cadence.kind;
            return (
              <button
                key={kind}
                onClick={() => pickKind(kind)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  width: "100%",
                  padding: "0.625rem 1rem",
                  background: selected ? "var(--fill-2)" : "transparent",
                  color: "var(--label-primary)",
                  textAlign: "left",
                  cursor: "pointer",
                  transition: "background 120ms",
                }}
                onMouseEnter={(e) => {
                  if (!selected)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "var(--fill-3)";
                }}
                onMouseLeave={(e) => {
                  if (!selected)
                    (e.currentTarget as HTMLButtonElement).style.background =
                      "transparent";
                }}
              >
                <span style={{ fontWeight: 600 }}>{LABELS[kind]}</span>
                <span
                  className="hig-caption-1"
                  style={{ color: "var(--label-tertiary)", marginTop: "0.125rem" }}
                >
                  {DESCRIPTIONS[kind]}
                </span>
              </button>
            );
          })}
        </div>
      </Popover>
    </>
  );
}
