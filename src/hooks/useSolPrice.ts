"use client";

import { useEffect, useState } from "react";
import { fetchPrices, MINTS } from "@/lib/jupiter";

const POLL_MS = 15_000;

export function useSolPrice(): { price: number | null; updatedAt: number | null; error: string | null } {
  const [price, setPrice] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    let alive = true;

    const tick = async () => {
      try {
        const prices = await fetchPrices([MINTS.SOL], ctrl.signal);
        const sol = prices[MINTS.SOL];
        if (!alive) return;
        if (sol) {
          setPrice(sol.usdPrice);
          setUpdatedAt(sol.updatedAt);
          setError(null);
        }
      } catch (e) {
        if (!alive || (e as Error).name === "AbortError") return;
        setError((e as Error).message);
      }
    };

    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      ctrl.abort();
      window.clearInterval(id);
    };
  }, []);

  return { price, updatedAt, error };
}
