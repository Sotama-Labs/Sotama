"use client";

import { useEffect, useState } from "react";
import { address } from "@solana/kit";
import { getRpc } from "@/lib/rpc";

const POLL_MS = 20_000;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function useWalletBalance(addr: string | null): {
  sol: number | null;
  loading: boolean;
  error: string | null;
} {
  const [sol, setSol] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!addr) {
      setSol(null);
      setError(null);
      return;
    }

    let alive = true;
    const rpc = getRpc();

    const tick = async () => {
      setLoading(true);
      try {
        const { value } = await rpc.getBalance(address(addr)).send();
        if (!alive) return;
        setSol(Number(value) / LAMPORTS_PER_SOL);
        setError(null);
      } catch (e) {
        if (!alive) return;
        setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };

    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [addr]);

  return { sol, loading, error };
}
