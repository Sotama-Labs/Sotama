"use client";

import { forwardRef, useState, type ReactNode } from "react";
import { Chevron, XMark } from "../icons";

/* ─────────────────────────────────────────────────────────────────────
   Slot — the original liquid-glass pill, restored. Each trigger / action
   gets its own pill with the HIG slot tokens (bg + blur + shadow).
   The remove ✕ lives INSIDE the pill as a second segment so the
   surrounding sentence keeps even spacing whether or not a slot is
   removable (NSTokenField / iOS Mail recipient pill pattern). The
   forwarded ref points at the main button so popovers anchor there.
   ───────────────────────────────────────────────────────────────────── */

type Props = {
  content: ReactNode;
  placeholder: string;
  active: boolean;
  hasValue: boolean;
  onClick: () => void;
  onRemove?: () => void;
};

export const Slot = forwardRef<HTMLButtonElement, Props>(function Slot(
  { content, placeholder, active, hasValue, onClick, onRemove },
  ref,
) {
  const [wrapperHover, setWrapperHover] = useState(false);
  const [removeHover, setRemoveHover] = useState(false);

  const wrapperBg = active
    ? "var(--accent-fill)"
    : wrapperHover
    ? "var(--slot-fill-hover)"
    : "var(--slot-fill)";

  return (
    <span
      onMouseEnter={() => setWrapperHover(true)}
      onMouseLeave={() => {
        setWrapperHover(false);
        setRemoveHover(false);
      }}
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        borderRadius: "0.5rem",
        background: wrapperBg,
        backdropFilter: "saturate(180%) blur(20px)",
        WebkitBackdropFilter: "saturate(180%) blur(20px)",
        boxShadow: active ? "var(--slot-shadow-active)" : "var(--slot-shadow)",
        overflow: "hidden",
        transition:
          "background 180ms cubic-bezier(0.32,0.72,0,1), box-shadow 180ms cubic-bezier(0.32,0.72,0,1)",
      }}
    >
      <button
        ref={ref}
        onClick={onClick}
        aria-haspopup="listbox"
        aria-expanded={active}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          fontSize: "inherit",
          fontWeight: "inherit",
          letterSpacing: "inherit",
          fontFamily: "inherit",
          padding: "0.25rem 0.625rem",
          color: hasValue ? "var(--label-primary)" : "var(--label-secondary)",
          background: "transparent",
          cursor: "pointer",
          transition: "color 160ms",
          whiteSpace: "nowrap",
          maxWidth: "100%",
        }}
      >
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.375rem",
            whiteSpace: "nowrap",
          }}
        >
          {hasValue ? content : placeholder}
        </span>
        <Chevron size={9} dir={active ? "up" : "down"} />
      </button>

      {onRemove && (
        <>
          <span
            aria-hidden
            style={{
              width: "0.5px",
              alignSelf: "stretch",
              background: "var(--separator)",
              opacity: 0.6,
            }}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            onMouseEnter={() => setRemoveHover(true)}
            onMouseLeave={() => setRemoveHover(false)}
            aria-label="Remove"
            title="Remove"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 0.625rem",
              background: removeHover ? "rgba(255, 59, 48, 0.12)" : "transparent",
              color: removeHover ? "var(--red)" : "var(--label-tertiary)",
              cursor: "pointer",
              transition: "background 120ms, color 120ms",
            }}
          >
            <XMark size={10} />
          </button>
        </>
      )}
    </span>
  );
});
