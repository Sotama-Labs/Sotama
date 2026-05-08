"use client";

import { useEffect, useMemo, useState } from "react";
import type { BuilderResult } from "./builder/ConditionalBuilder";
import type { Cadence } from "@/lib/types";

/* ─────────────────────────────────────────────────────────────────────
   TuningSheet — focused step that sits between the green save tick on
   the builder and the on-chain DepositSheet. Only renders when the
   cadence is something other than `Once`.

   Why it exists: keeping `every 10 minutes` and `until 24 hours from
   now` in the trigger/action sentence makes both clauses unreadable.
   This sheet pulls the operational dials (polling floor, deadline,
   total runs) out into a single small surface that reads like one
   sentence and lets the user tune before signing.

   The component is dumb about the on-chain layer — it returns an
   updated BuilderResult with the user's tuned cadence + interval, and
   the parent decides what to do (here: hand it to DepositSheet).
   ───────────────────────────────────────────────────────────────────── */

type IntervalUnit = "min" | "hour" | "day";

const UNIT_SECS: Record<IntervalUnit, number> = {
  min: 60,
  hour: 60 * 60,
  day: 60 * 60 * 24,
};

const UNIT_LABELS: Record<IntervalUnit, [string, string]> = {
  min: ["minute", "minutes"],
  hour: ["hour", "hours"],
  day: ["day", "days"],
};

function decomposeInterval(secs: number): { value: number; unit: IntervalUnit } {
  if (secs <= 0) return { value: 10, unit: "min" };
  const order: IntervalUnit[] = ["day", "hour", "min"];
  for (const u of order) {
    const s = UNIT_SECS[u];
    if (secs % s === 0) return { value: secs / s, unit: u };
  }
  return { value: Math.max(1, Math.round(secs / 60)), unit: "min" };
}

function unixToInputValue(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

function inputValueToUnix(s: string): number | null {
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000);
}

const SOLANA_AVG_SLOT_SECS = 0.4;

/* ── Visual primitives ─────────────────────────────────────────────── */

const labelStyle: React.CSSProperties = {
  color: "var(--label-tertiary)",
  fontSize: "0.75rem",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
};

const inputStyle: React.CSSProperties = {
  padding: "0.5rem 0.625rem",
  border: "0.5px solid var(--separator)",
  borderRadius: "0.5rem",
  background: "var(--bg-system)",
  color: "var(--label-primary)",
  fontSize: "0.95rem",
  fontFamily: "inherit",
  outline: "none",
  fontFeatureSettings: '"tnum"',
};

/* ── Sheet ─────────────────────────────────────────────────────────── */

export type TuningResult = {
  cadence: Cadence;
  minIntervalSecs: number;
};

export function TuningSheet({
  open,
  draft,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  draft: BuilderResult | null;
  onCancel: () => void;
  onConfirm: (tuned: TuningResult) => void;
}) {
  // Local working copy — committed only when the user clicks Continue.
  const [intervalValue, setIntervalValue] = useState("10");
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>("min");
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const [totalDraft, setTotalDraft] = useState("3");

  useEffect(() => {
    if (!open || !draft) return;
    const { value, unit } = decomposeInterval(draft.minIntervalSecs);
    setIntervalValue(String(value));
    setIntervalUnit(unit);
    if (draft.cadence.kind === "until") {
      setDeadlineDraft(unixToInputValue(draft.cadence.unixDeadline));
    }
    if (draft.cadence.kind === "repeat") {
      setTotalDraft(String(draft.cadence.total));
    }
  }, [open, draft]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  const intervalSecs = useMemo(() => {
    const n = parseInt(intervalValue, 10);
    if (!Number.isFinite(n) || n < 1) return 0;
    return n * UNIT_SECS[intervalUnit];
  }, [intervalValue, intervalUnit]);

  const totalRuns = useMemo(() => {
    const n = parseInt(totalDraft, 10);
    return Number.isFinite(n) && n >= 1 ? n : 0;
  }, [totalDraft]);

  const deadlineUnix = useMemo(() => inputValueToUnix(deadlineDraft), [deadlineDraft]);

  if (!open || !draft || draft.cadence.kind === "once") return null;

  const isUntil = draft.cadence.kind === "until";
  const isRepeat = draft.cadence.kind === "repeat";

  // Validation. Continue is disabled until the inputs make sense.
  const intervalValid = intervalSecs >= 60;
  const deadlineValid =
    !isUntil ||
    (deadlineUnix != null && deadlineUnix > Math.floor(Date.now() / 1000));
  const totalValid = !isRepeat || totalRuns >= 1;
  const canContinue = intervalValid && deadlineValid && totalValid;

  // Plain-English preview block — anchors what the user is configuring
  // so they don't have to remember the sentence they just wrote.
  const previewSentence = isUntil
    ? `Polls every ${intervalValue} ${pluralUnit(
        intervalUnit,
        Number(intervalValue) || 0,
      )}, runs the action whenever the condition is true, stops at the deadline.`
    : `Polls every ${intervalValue} ${pluralUnit(
        intervalUnit,
        Number(intervalValue) || 0,
      )}, runs up to ${totalRuns || "?"} times, then stops.`;

  // Fast-fire warning: if the interval is below ~30s the keeper will
  // hammer the chain. Surface it inline so the user knows.
  const intervalBlocks = Math.max(
    1,
    Math.round(intervalSecs / SOLANA_AVG_SLOT_SECS),
  );

  const commit = () => {
    if (!canContinue) return;
    let nextCadence: Cadence;
    if (isUntil) {
      nextCadence = { kind: "until", unixDeadline: deadlineUnix as number };
    } else {
      nextCadence = { kind: "repeat", total: totalRuns };
    }
    onConfirm({ cadence: nextCadence, minIntervalSecs: intervalSecs });
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "hig-fade-in 200ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "26rem",
          margin: "1rem",
          background: "var(--bg-system)",
          borderRadius: "var(--radius-sheet)",
          border: "0.5px solid var(--separator)",
          boxShadow: "var(--shadow-popover)",
          overflow: "hidden",
          animation: "hig-pop-in 240ms cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        <div style={{ padding: "1.25rem 1.25rem 0.5rem", textAlign: "center" }}>
          <div className="hig-headline" style={{ marginBottom: "0.25rem" }}>
            How often should this run?
          </div>
          <div
            className="hig-subheadline"
            style={{ color: "var(--label-secondary)" }}
          >
            {isUntil
              ? "Pick a polling rate and a stop date."
              : "Pick a polling rate and a total number of runs."}
          </div>
        </div>

        <div style={{ padding: "0.875rem 1.25rem 1rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* ── Polling floor ─────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <span style={labelStyle}>Run no more than once every</span>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="number"
                min={1}
                max={10_000}
                value={intervalValue}
                onChange={(e) => setIntervalValue(e.target.value)}
                style={{ ...inputStyle, flex: "0 0 6rem", textAlign: "right" }}
                aria-label="Interval value"
              />
              <select
                value={intervalUnit}
                onChange={(e) => setIntervalUnit(e.target.value as IntervalUnit)}
                style={{ ...inputStyle, flex: 1 }}
                aria-label="Interval unit"
              >
                <option value="min">minutes</option>
                <option value="hour">hours</option>
                <option value="day">days</option>
              </select>
            </div>
            <span
              className="hig-footnote"
              style={{ color: "var(--label-tertiary)" }}
            >
              {intervalValid
                ? `Roughly every ${intervalBlocks.toLocaleString()} Solana slots — the keeper polls more often than this, but the on-chain floor prevents back-to-back fires.`
                : "Minimum 1 minute."}
            </span>
          </div>

          {/* ── Bound: deadline (While) ───────────────────────────── */}
          {isUntil && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <span style={labelStyle}>Stop after</span>
              <input
                type="datetime-local"
                value={deadlineDraft}
                onChange={(e) => setDeadlineDraft(e.target.value)}
                style={inputStyle}
                aria-label="Deadline"
              />
              {!deadlineValid && (
                <span
                  className="hig-footnote"
                  style={{ color: "var(--accent-warning, #c83a14)" }}
                >
                  Pick a date in the future.
                </span>
              )}
            </div>
          )}

          {/* ── Bound: total runs (For) ───────────────────────────── */}
          {isRepeat && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <span style={labelStyle}>Run a total of</span>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <input
                  type="number"
                  min={1}
                  max={10_000}
                  value={totalDraft}
                  onChange={(e) => setTotalDraft(e.target.value)}
                  style={{ ...inputStyle, flex: "0 0 6rem", textAlign: "right" }}
                  aria-label="Total runs"
                />
                <span style={{ color: "var(--label-secondary)" }}>
                  {totalRuns === 1 ? "time" : "times"}
                </span>
              </div>
            </div>
          )}

          {/* ── Preview ───────────────────────────────────────────── */}
          <div
            style={{
              padding: "0.75rem 0.875rem",
              background: "var(--fill-4)",
              border: "0.5px solid var(--separator)",
              borderRadius: "0.625rem",
              color: "var(--label-secondary)",
              fontSize: "0.85rem",
              lineHeight: 1.45,
            }}
          >
            {previewSentence}
          </div>
        </div>

        {/* ── Footer ─────────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            gap: "0.625rem",
            padding: "0.875rem 1.25rem 1.25rem",
            borderTop: "0.5px solid var(--separator)",
          }}
        >
          <button
            onClick={onCancel}
            style={{
              flex: 1,
              padding: "0.625rem 1rem",
              borderRadius: "0.625rem",
              background: "var(--fill-3)",
              color: "var(--label-primary)",
              fontWeight: 500,
              fontSize: "0.95rem",
              cursor: "pointer",
            }}
          >
            Back
          </button>
          <button
            onClick={commit}
            disabled={!canContinue}
            style={{
              flex: 1,
              padding: "0.625rem 1rem",
              borderRadius: "0.625rem",
              background: canContinue ? "var(--accent)" : "var(--fill-3)",
              color: canContinue ? "white" : "var(--label-tertiary)",
              fontWeight: 600,
              fontSize: "0.95rem",
              cursor: canContinue ? "pointer" : "not-allowed",
              transition: "background 160ms",
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

function pluralUnit(unit: IntervalUnit, n: number): string {
  const [singular, plural] = UNIT_LABELS[unit];
  return n === 1 ? singular : plural;
}
