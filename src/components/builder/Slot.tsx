"use client";

import { forwardRef, useState, type ReactNode } from "react";
import { Chevron } from "../icons";

type Props = {
  content: ReactNode;
  placeholder: string;
  active: boolean;
  hasValue: boolean;
  onClick: () => void;
};

export const Slot = forwardRef<HTMLButtonElement, Props>(function Slot(
  { content, placeholder, active, hasValue, onClick },
  ref,
) {
  const [hover, setHover] = useState(false);

  return (
    <button
      ref={ref}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
        borderRadius: "0.5rem",
        color: hasValue ? "var(--label-primary)" : "var(--label-secondary)",
        background: active ? "var(--accent-fill)" : hover ? "var(--slot-fill-hover)" : "var(--slot-fill)",
        backdropFilter: "saturate(180%) blur(20px)",
        WebkitBackdropFilter: "saturate(180%) blur(20px)",
        boxShadow: active ? "var(--slot-shadow-active)" : "var(--slot-shadow)",
        cursor: "pointer",
        transition:
          "background 180ms cubic-bezier(0.32,0.72,0,1), box-shadow 180ms cubic-bezier(0.32,0.72,0,1), color 160ms",
        whiteSpace: "nowrap",
        maxWidth: "100%",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem", whiteSpace: "nowrap" }}>
        {hasValue ? content : placeholder}
      </span>
      <Chevron size={9} dir={active ? "up" : "down"} />
    </button>
  );
});
