"use client";

import { SOL_USD_FEED_ID } from "@/lib/oracles";
import { usePythPrice } from "./usePythPrice";

/** Live SOL/USD price via Pyth Hermes. Same shape as the legacy hook. */
export function useSolPrice({ enabled = true }: { enabled?: boolean } = {}): {
  price: number | null;
  error: string | null;
} {
  const { price, status } = usePythPrice(enabled ? SOL_USD_FEED_ID : null);
  return {
    price,
    error: status === "error" ? "Pyth Hermes unreachable" : null,
  };
}
