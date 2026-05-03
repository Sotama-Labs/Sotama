"use client";

import { useState } from "react";
import { Check } from "../icons";

export function MenuRow({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="hig-body"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        padding: "0.4375rem 0.75rem",
        background: hover ? "var(--accent)" : "transparent",
        color: hover ? "white" : "var(--label-primary)",
        textAlign: "left",
        fontSize: "0.875rem",
        lineHeight: "1.25rem",
        transition: "background 60ms",
      }}
    >
      <span>{label}</span>
      {selected && <Check size={14} />}
    </button>
  );
}
