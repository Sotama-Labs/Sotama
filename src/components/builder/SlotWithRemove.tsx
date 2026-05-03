"use client";

import { useState, type RefObject } from "react";
import { Slot } from "./Slot";

export function SlotWithRemove({
  slotRef,
  active,
  hasValue,
  value,
  placeholder,
  onClick,
  showRemove,
  onRemove,
}: {
  slotRef: RefObject<HTMLButtonElement>;
  active: boolean;
  hasValue: boolean;
  value: string | null;
  placeholder: string;
  onClick: () => void;
  showRemove: boolean;
  onRemove: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", position: "relative" }}
    >
      <Slot ref={slotRef} active={active} hasValue={hasValue} value={value} placeholder={placeholder} onClick={onClick} />
      {showRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove"
          tabIndex={hover || active ? 0 : -1}
          style={{
            width: "1.125rem",
            height: "1.125rem",
            borderRadius: "999px",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--fill-2)",
            color: "var(--label-secondary)",
            opacity: hover || active ? 1 : 0,
            transform: hover || active ? "scale(1)" : "scale(0.7)",
            transition: "opacity 140ms, transform 140ms cubic-bezier(0.32,0.72,0,1)",
            cursor: "pointer",
          }}
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1.5 1.5 L6.5 6.5 M6.5 1.5 L1.5 6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </span>
  );
}
