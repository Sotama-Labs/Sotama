"use client";

import { useState } from "react";
import { Check } from "../icons";

export function MenuRow({
  label,
  selected,
  onClick,
  description,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
  description?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "0.75rem",
        width: "100%",
        padding: "0.6875rem 0.875rem",
        background: hover ? "var(--accent)" : "transparent",
        color: hover ? "white" : "var(--label-primary)",
        textAlign: "left",
        transition: "background 60ms",
      }}
    >
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: "0.0625rem" }}>
        <span
          className="hig-body"
          style={{ fontWeight: 500, fontSize: "0.9375rem", lineHeight: "1.25rem" }}
        >
          {label}
        </span>
        {description && (
          <span
            className="hig-caption-1"
            style={{
              color: hover ? "rgba(255,255,255,0.78)" : "var(--label-secondary)",
              transition: "color 60ms",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {description}
          </span>
        )}
      </div>
      {selected && <Check size={16} />}
    </button>
  );
}
