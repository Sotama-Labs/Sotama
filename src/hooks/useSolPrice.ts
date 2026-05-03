"use client";

import { fetchPrices, MINTS } from "@/lib/jupiter";
import { usePolling } from "./usePolling";

const POLL_MS = 15_000;

export function useSolPrice({ enabled = true }: { enabled?: boolean } = {}): {
  price: number | null;
  error: string | null;
} {
  const { data, error } = usePolling<number>({
    intervalMs: POLL_MS,
    enabled,
    abortable: true,
    fn: async (signal) => {
      const prices = await fetchPrices([MINTS.SOL], signal);
      return prices[MINTS.SOL]?.usdPrice ?? null;
    },
  });
  return { price: data, error };
}
