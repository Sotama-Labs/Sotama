"use client";

import { useCallback, useEffect, useState } from "react";
import type { Tweaks } from "@/lib/types";

const KEY = "sotama:tweaks";

const DEFAULTS: Tweaks = {
  appearance: "auto",
  accent: "#007AFF",
};

export function useTweaks(): [Tweaks, (key: keyof Tweaks, value: Tweaks[keyof Tweaks]) => void] {
  const [tweaks, setTweaks] = useState<Tweaks>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) setTweaks({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
  }, []);

  const setTweak = useCallback((key: keyof Tweaks, value: Tweaks[keyof Tweaks]) => {
    setTweaks((prev) => {
      const next = { ...prev, [key]: value } as Tweaks;
      try {
        window.localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  return [tweaks, setTweak];
}

export function resolveAppearance(value: Tweaks["appearance"]): "light" | "dark" {
  if (value === "light" || value === "dark") return value;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}
