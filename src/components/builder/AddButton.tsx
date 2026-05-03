"use client";

import { useState, type ButtonHTMLAttributes } from "react";
import { Plus } from "../icons";

export function AddButton({ onClick, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPressed(false);
      }}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      {...rest}
      style={{
        width: "1.625rem",
        height: "1.625rem",
        flexShrink: 0,
        borderRadius: "999px",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: hover ? "color-mix(in oklab, var(--green) 92%, white 8%)" : "var(--green)",
        color: "white",
        border: "none",
        padding: 0,
        margin: 0,
        lineHeight: 0,
        boxSizing: "border-box",
        boxShadow:
          "0 0 0 0.5px rgba(0,0,0,0.10), " +
          (hover ? "0 2px 8px rgba(48, 209, 88, 0.40), " : "0 1px 2px rgba(0,0,0,0.10), ") +
          "inset 0 0.5px 0 rgba(255,255,255,0.40)",
        transformOrigin: "center center",
        transform: pressed ? "scale(0.94)" : hover ? "scale(1.05)" : "scale(1)",
        transition: "transform 180ms cubic-bezier(0.32,0.72,0,1), background 160ms ease, box-shadow 200ms ease",
        cursor: "pointer",
        willChange: "transform",
      }}
    >
      <Plus size={12} />
    </button>
  );
}
