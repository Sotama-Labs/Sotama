"use client";

import { useState } from "react";
import { Check } from "../icons";

export function MenuRow({
  label,
  selected,
  onClick,
  description,
  disabled = false,
  disabledReason,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  description?: string;
  disabled?: boolean;
  /** Replaces `description` when disabled. Defaults to "Coming soon". */
  disabledReason?: string;
}) {
  const [hover, setHover] = useState(false);
  const showHover = hover && !disabled;
  const sub = disabled ? (disabledReason ?? "Coming soon") : description;

  return (
    <button
      onClick={() => {
        if (disabled) return;
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-disabled={disabled || undefined}
      title={disabled ? (disabledReason ?? "Coming soon") : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "0.75rem",
        width: "100%",
        padding: "0.6875rem 0.875rem",
        background: showHover ? "var(--accent)" : "transparent",
        color: showHover ? "white" : "var(--label-primary)",
        textAlign: "left",
        transition: "background 60ms",
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "0.0625rem" }}>
        <span
          className="hig-body"
          style={{ fontWeight: 500, fontSize: "0.9375rem", lineHeight: "1.25rem" }}
        >
          {label}
        </span>
        {sub && (
          <span
            className="hig-caption-1"
            style={{
              color: showHover ? "rgba(255,255,255,0.78)" : "var(--label-secondary)",
              transition: "color 60ms",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontStyle: disabled ? "italic" : undefined,
            }}
          >
            {sub}
          </span>
        )}
      </div>
      {selected && !disabled && <Check size={16} />}
    </button>
  );
}
