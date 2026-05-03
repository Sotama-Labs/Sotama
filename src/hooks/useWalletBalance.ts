"use client";

import { address } from "@solana/kit";
import { useEffect, useState } from "react";
import { HAS_HELIUS, RPC_URL, getRpc } from "@/lib/rpc";
import { usePolling } from "./usePolling";

const POLL_MS = 20_000;
const LAMPORTS_PER_SOL = 1_000_000_000;
const MAX_WS_RECONNECTS = 4;

function deriveWsUrl(httpUrl: string): string | null {
  try {
    const u = new URL(httpUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  } catch {
    return null;
  }
}

export function useWalletBalance(
  addr: string | null,
  { enabled = true }: { enabled?: boolean } = {},
): { sol: number | null; error: string | null } {
  const wsUrl = HAS_HELIUS ? deriveWsUrl(RPC_URL) : null;
  const [wsFailed, setWsFailed] = useState(false);
  const useWs = !!wsUrl && !wsFailed;

  const [wsSol, setWsSol] = useState<number | null>(null);
  const [wsError, setWsError] = useState<string | null>(null);

  useEffect(() => {
    if (!useWs || !enabled || !addr || !wsUrl) {
      setWsSol(null);
      return;
    }
    let alive = true;
    let ws: WebSocket | null = null;
    let subId: number | null = null;
    let reconnectTimer: number | null = null;
    let attempts = 0;

    const seed = async () => {
      try {
        const { value } = await getRpc().getBalance(address(addr)).send();
        if (alive) setWsSol(Number(value) / LAMPORTS_PER_SOL);
      } catch {
        // notifications will fill it in
      }
    };

    const connect = () => {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        attempts = 0;
        ws?.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "accountSubscribe",
            params: [addr, { encoding: "base64", commitment: "confirmed" }],
          }),
        );
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (msg.id === 1 && typeof msg.result === "number") {
            subId = msg.result;
            return;
          }
          if (msg.method === "accountNotification") {
            const lamports = msg.params?.result?.value?.lamports;
            if (typeof lamports === "number" && alive) {
              setWsSol(lamports / LAMPORTS_PER_SOL);
              setWsError((p) => (p === null ? p : null));
            }
          }
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        attempts += 1;
        if (attempts >= MAX_WS_RECONNECTS) {
          setWsFailed(true);
          setWsError("WebSocket unavailable; falling back to polling");
          return;
        }
        const delay = Math.min(1000 * 2 ** attempts, 10_000);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    seed();
    connect();

    return () => {
      alive = false;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      if (ws && subId !== null && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "accountUnsubscribe",
            params: [subId],
          }),
        );
      }
      ws?.close();
    };
  }, [addr, enabled, useWs, wsUrl]);

  const { data: pollSol, error: pollError } = usePolling<number>({
    intervalMs: POLL_MS,
    enabled: !useWs && enabled && !!addr,
    deps: [addr],
    fn: async () => {
      if (!addr) return null;
      const { value } = await getRpc().getBalance(address(addr)).send();
      return Number(value) / LAMPORTS_PER_SOL;
    },
  });

  const sol = useWs ? wsSol : pollSol;
  const error = useWs ? wsError : pollError;
  return { sol: addr ? sol : null, error };
}
