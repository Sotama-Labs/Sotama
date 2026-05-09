"use client";

import { useEffect, useState } from "react";
import { fetchJupiterPriceUSD } from "@/lib/jupiter";

export type JupiterPriceStatus = "idle" | "polling" | "error";

export type UseJupiterPriceResult = {
  price: number | null;
  updatedAt: number | null;
  status: JupiterPriceStatus;
};

/** Live USD price for an SPL mint via Jupiter Price API v3. Polls at
 *  5s by default — Jupiter Lite rate limits aren't strict but there's
 *  no SSE channel, so polling is the only option. Pass `null` to
 *  disable. Mirror of `usePythPrice` so AssetPriceEditor can show a
 *  live preview when the asset's resolved oracle is Jupiter (a token
 *  without a Pyth feed). */
export function useJupiterPrice(
  mint: string | null,
  pollMs: number = 5000,
): UseJupiterPriceResult {
  const [price, setPrice] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<JupiterPriceStatus>("idle");

  useEffect(() => {
    if (!mint) {
      setPrice(null);
      setUpdatedAt(null);
      setStatus("idle");
      return;
    }

    let alive = true;
    setStatus("polling");

    const tick = async () => {
      const u = await fetchJupiterPriceUSD(mint);
      if (!alive) return;
      if (u) {
        setPrice(u.price);
        setUpdatedAt(Date.now());
        setStatus("polling");
      } else {
        setStatus("error");
      }
    };

    void tick();
    const interval = window.setInterval(tick, pollMs);

    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [mint, pollMs]);

  return { price, updatedAt, status };
}
