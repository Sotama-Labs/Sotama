"use client";

import { useEffect, useRef, useState } from "react";

type PollingArgs<T> = {
  fn: (signal?: AbortSignal) => Promise<T | null>;
  intervalMs: number;
  enabled?: boolean;
  abortable?: boolean;
  deps?: unknown[];
};

/**
 * Polling primitive: invokes `fn` every `intervalMs` while `enabled` and the tab is visible.
 * Bails the React state update when the new value matches the previous (Object.is).
 * Aborts the in-flight request on unmount/dep-change/disable when `abortable` is true.
 */
export function usePolling<T>({
  fn,
  intervalMs,
  enabled = true,
  abortable = false,
  deps = [],
}: PollingArgs<T>): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let ctrl: AbortController | null = null;

    const tick = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (abortable) {
        ctrl?.abort();
        ctrl = new AbortController();
      }
      try {
        const next = await fnRef.current(ctrl?.signal);
        if (!alive || next == null) return;
        setData((prev) => (Object.is(prev, next) ? prev : next));
        setError((prev) => (prev === null ? prev : null));
      } catch (e) {
        const err = e as Error;
        if (!alive || err.name === "AbortError") return;
        setError(err.message);
      }
    };

    tick();
    const id = window.setInterval(tick, intervalMs);
    const onVis = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      alive = false;
      ctrl?.abort();
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, abortable, ...deps]);

  return { data, error };
}
