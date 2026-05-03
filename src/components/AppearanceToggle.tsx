"use client";

import { useState } from "react";
import type { Tweaks } from "@/lib/types";
import { resolveAppearance } from "@/hooks/useTweaks";
import { Moon, Sun } from "./icons";

type Appearance = Tweaks["appearance"];

export function AppearanceToggle({
  appearance,
  onChange,
}: {
  appearance: Appearance;
  onChange: (next: Appearance) => void;
}) {
  const [hover, setHover] = useState(false);
  const isDark = resolveAppearance(appearance) === "dark";
  const next: Appearance = isDark ? "light" : "dark";
  const label = isDark ? "Switch to Light mode" : "Switch to Dark mode";

  return (
    <button
      onClick={() => onChange(next)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={label}
      title={label}
      style={{
        width: "2.375rem",
        height: "2.375rem",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: "none",
        margin: 0,
        borderRadius: "999px",
        background: hover ? "var(--slot-fill-hover)" : "var(--slot-fill)",
        backdropFilter: "saturate(180%) blur(20px)",
        WebkitBackdropFilter: "saturate(180%) blur(20px)",
        boxShadow: "var(--slot-shadow)",
        color: "var(--label-primary)",
        cursor: "pointer",
        transition: "background 160ms ease, transform 160ms ease",
        transform: hover ? "scale(1.04)" : "scale(1)",
      }}
    >
      {isDark ? <Moon size={20} /> : <Sun size={20} />}
    </button>
  );
}
