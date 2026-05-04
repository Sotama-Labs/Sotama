"use client";

import { useEffect, useState } from "react";
import { subscribePythStream, type PriceUpdate } from "@/lib/oracles";

export type PythStatus = "idle" | "live" | "polling" | "error";

export type UsePythPriceResult = {
  price: number | null;
  confidence: number | null;
  updatedAt: number | null;
  status: PythStatus;
};

/** Subscribe to a single Pyth feed. Pass null to disable. */
export function usePythPrice(feedId: string | null): UsePythPriceResult {
  const [price, setPrice] = useState<number | null>(null);
  const [confidence, setConfidence] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [status, setStatus] = useState<PythStatus>("idle");

  useEffect(() => {
    if (!feedId) {
      setPrice(null);
      setConfidence(null);
      setUpdatedAt(null);
      setStatus("idle");
      return;
    }

    let alive = true;
    setStatus("live");

    const handle = subscribePythStream(
      feedId,
      (u: PriceUpdate) => {
        if (!alive) return;
        setPrice(u.price);
        setConfidence(u.confidence);
        setUpdatedAt(u.publishTime);
      },
      (mode) => {
        if (!alive) return;
        setStatus(mode);
      },
    );

    return () => {
      alive = false;
      handle.close();
    };
  }, [feedId]);

  return { price, confidence, updatedAt, status };
}
