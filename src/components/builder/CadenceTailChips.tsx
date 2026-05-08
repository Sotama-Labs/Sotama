"use client";

import { createRef, useMemo, useState, type RefObject } from "react";
import { Popover } from "./Popover";

/* ─────────────────────────────────────────────────────────────────────
   Tail chips that hang off the action row when cadence ≠ "once":
     • RepeatCountChip   — "× N times" (Cadence.Repeat)
     • DeadlineChip      — "until <date>" (Cadence.Until)
     • IntervalChip      — "every N <unit>" (min_interval_secs floor; both)

   Each chip opens a small popover with a native input. Values commit on
   blur/Enter; popover closes on outside click. The chip's display string
   is the canonical rendering of the value.
   ───────────────────────────────────────────────────────────────────── */

function chipStyle(open: boolean, hover: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    padding: "0.125rem 0.5rem",
    borderRadius: "0.375rem",
    background: open || hover ? "var(--fill-3)" : "var(--fill-2)",
    color: "var(--label-secondary)",
    fontSize: "inherit",
    fontFamily: "inherit",
    fontWeight: 400,
    letterSpacing: "inherit",
    transition: "background 120ms",
    cursor: "pointer",
    boxShadow: "inset 0 0 0 0.5px var(--separator)",
  };
}

const popoverBoxStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  padding: "0.875rem 1rem",
};

const captionStyle: React.CSSProperties = {
  color: "var(--label-tertiary)",
  fontSize: "0.75rem",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.625rem",
  border: "0.5px solid var(--separator)",
  borderRadius: "0.5rem",
  background: "var(--bg-system)",
  color: "var(--label-primary)",
  fontSize: "0.875rem",
  fontFamily: "inherit",
  outline: "none",
};

/* ── Repeat count ──────────────────────────────────────────────────── */

export function RepeatCountChip({
  total,
  onChange,
}: {
  total: number;
  onChange: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(String(total));
  const anchor = createRef<HTMLButtonElement>() as RefObject<HTMLButtonElement>;

  const commit = () => {
    const n = parseInt(draft, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 10_000) {
      onChange(n);
    } else {
      setDraft(String(total));
    }
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchor}
        onClick={() => {
          setDraft(String(total));
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Number of times to fire"
        style={chipStyle(open, hover)}
      >
        {total}
      </button>
      <Popover
        anchorRef={anchor}
        open={open}
        onClose={commit}
        width={220}
        align="start"
      >
        <div style={popoverBoxStyle}>
          <span style={captionStyle}>Total fires</span>
          <input
            type="number"
            min={1}
            max={10_000}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setOpen(false);
            }}
            style={inputStyle}
          />
        </div>
      </Popover>
    </>
  );
}

/* ── Deadline ──────────────────────────────────────────────────────── */

function unixToInputValue(unix: number): string {
  // <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in local TZ.
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

function formatDeadlineLabel(unix: number): string {
  const d = new Date(unix * 1000);
  const now = Date.now();
  const diffMs = d.getTime() - now;
  // Lives inside "until <chip>" — labels should slot in like a date
  // phrase, not include "until" or its inverse ("expired"). For past
  // dates we just show the date and let the user re-pick.
  if (diffMs < 0) return d.toLocaleDateString();
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours < 24) {
    const h = Math.max(1, Math.round(diffHours));
    return h === 1 ? "1 hour from now" : `${h} hours from now`;
  }
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 14) return diffDays === 1 ? "tomorrow" : `${diffDays} days from now`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "2-digit",
  });
}

export function DeadlineChip({
  unixDeadline,
  onChange,
}: {
  unixDeadline: number;
  onChange: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState(unixToInputValue(unixDeadline));
  const anchor = createRef<HTMLButtonElement>() as RefObject<HTMLButtonElement>;
  const label = useMemo(
    () => formatDeadlineLabel(unixDeadline),
    [unixDeadline],
  );

  const commit = () => {
    const ts = inputValueToUnix(draft);
    if (ts != null && ts > Math.floor(Date.now() / 1000)) {
      onChange(ts);
    } else {
      setDraft(unixToInputValue(unixDeadline));
    }
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchor}
        onClick={() => {
          setDraft(unixToInputValue(unixDeadline));
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Deadline after which the automation stops firing"
        style={chipStyle(open, hover)}
      >
        {label}
      </button>
      <Popover
        anchorRef={anchor}
        open={open}
        onClose={commit}
        width={280}
        align="start"
      >
        <div style={popoverBoxStyle}>
          <span style={captionStyle}>Stop firing after</span>
          <input
            type="datetime-local"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setOpen(false);
            }}
            style={inputStyle}
          />
        </div>
      </Popover>
    </>
  );
}

/* ── Interval (min_interval_secs floor) ────────────────────────────── */

type IntervalUnit = "sec" | "min" | "hour" | "day";

const UNIT_SECS: Record<IntervalUnit, number> = {
  sec: 1,
  min: 60,
  hour: 60 * 60,
  day: 60 * 60 * 24,
};

const UNIT_LABELS: Record<IntervalUnit, [string, string]> = {
  sec: ["second", "seconds"],
  min: ["minute", "minutes"],
  hour: ["hour", "hours"],
  day: ["day", "days"],
};

/** Pick the largest unit that divides `secs` evenly so labels stay clean.
 *  e.g. 3600 → (1, hour), 90 → (90, sec), 0 → (0, min). */
function decomposeInterval(secs: number): { value: number; unit: IntervalUnit } {
  if (secs <= 0) return { value: 0, unit: "min" };
  const order: IntervalUnit[] = ["day", "hour", "min", "sec"];
  for (const u of order) {
    const s = UNIT_SECS[u];
    if (secs % s === 0) return { value: secs / s, unit: u };
  }
  return { value: secs, unit: "sec" };
}

function formatIntervalLabel(secs: number): string {
  // Lives inside "every <chip>". A throttle of 0 reads as "no minimum
  // gap" — surface it explicitly so the chip itself carries the meaning.
  if (secs <= 0) return "no min";
  const { value, unit } = decomposeInterval(secs);
  const [singular, plural] = UNIT_LABELS[unit];
  return `${value} ${value === 1 ? singular : plural}`;
}

export function IntervalChip({
  minIntervalSecs,
  onChange,
}: {
  minIntervalSecs: number;
  onChange: (next: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const initial = decomposeInterval(minIntervalSecs);
  const [draftValue, setDraftValue] = useState(String(initial.value));
  const [draftUnit, setDraftUnit] = useState<IntervalUnit>(initial.unit);
  const anchor = createRef<HTMLButtonElement>() as RefObject<HTMLButtonElement>;

  const commit = () => {
    const n = parseInt(draftValue, 10);
    if (Number.isFinite(n) && n >= 0) {
      const totalSecs = n * UNIT_SECS[draftUnit];
      // u32 ceiling — anything past ~136 years is silly; clamp to 30 days
      // for safety since real automations don't need > a month between
      // fires (they'd just be `Once`).
      onChange(Math.min(totalSecs, UNIT_SECS.day * 30));
    } else {
      const { value, unit } = decomposeInterval(minIntervalSecs);
      setDraftValue(String(value));
      setDraftUnit(unit);
    }
    setOpen(false);
  };

  return (
    <>
      <button
        ref={anchor}
        onClick={() => {
          const { value, unit } = decomposeInterval(minIntervalSecs);
          setDraftValue(String(value));
          setDraftUnit(unit);
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Minimum gap between fires"
        style={chipStyle(open, hover)}
      >
        {formatIntervalLabel(minIntervalSecs)}
      </button>
      <Popover
        anchorRef={anchor}
        open={open}
        onClose={commit}
        width={300}
        align="start"
      >
        <div style={popoverBoxStyle}>
          <span style={captionStyle}>Minimum gap between fires</span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input
              type="number"
              min={0}
              max={10_000}
              value={draftValue}
              autoFocus
              onChange={(e) => setDraftValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setOpen(false);
              }}
              style={{ ...inputStyle, flex: 1 }}
            />
            <select
              value={draftUnit}
              onChange={(e) => setDraftUnit(e.target.value as IntervalUnit)}
              style={{ ...inputStyle, flex: 1 }}
            >
              <option value="sec">sec</option>
              <option value="min">min</option>
              <option value="hour">hour</option>
              <option value="day">day</option>
            </select>
          </div>
          <span style={captionStyle}>
            Set to 0 to let the keeper fire as fast as the trigger allows.
          </span>
        </div>
      </Popover>
    </>
  );
}
