"use client";

import { useRef, useState } from "react";
import { Popover } from "./builder/Popover";
import { MenuRow } from "./builder/MenuRow";
import { Chevron } from "./icons";

type Option<T extends string> = { value: T; label: string };

export function CompactNav<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="hig-subheadline"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.4375rem",
          padding: "0.5rem 0.875rem",
          background: "var(--slot-fill)",
          backdropFilter: "saturate(180%) blur(20px)",
          WebkitBackdropFilter: "saturate(180%) blur(20px)",
          boxShadow: "var(--slot-shadow)",
          color: "var(--label-primary)",
          borderRadius: "0.625rem",
          fontWeight: 600,
          letterSpacing: "-0.014em",
          fontSize: "1rem",
          lineHeight: "1.25rem",
          whiteSpace: "nowrap",
          cursor: "pointer",
        }}
      >
        <span>{current.label}</span>
        <span style={{ display: "inline-flex", color: "var(--label-tertiary)" }}>
          <Chevron size={9} dir={open ? "up" : "down"} />
        </span>
      </button>

      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} width={180} align="end">
        <div className="fade-slide" style={{ padding: "0.25rem 0" }}>
          {options.map((o) => (
            <MenuRow
              key={o.value}
              label={o.label}
              selected={o.value === value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            />
          ))}
        </div>
      </Popover>
    </>
  );
}
