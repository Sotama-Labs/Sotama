/** Pyth Lazer WebSocket client (raw JSON-RPC, no SDK dependency).
 *
 *  We talk to the Lazer "WebSocket-native stream" endpoints directly. The
 *  protocol is documented at https://docs.pyth.network/lazer/ws-stream-api.
 *  Using the raw protocol avoids depending on a TypeScript SDK whose API
 *  surface has been a moving target; if a stable SDK ships we can adopt it
 *  by swapping this file.
 *
 *  Subscription messages take the shape:
 *    { type: "subscribe", subscriptionId, priceFeedIds, properties,
 *      formats, channel }
 *  Updates arrive as `{ type: "streamUpdated", parsed: { priceFeeds: [...] } }`.
 *  We forward the parsed `priceFeed` entries to listeners as `PythTickEvent`s. */

import { WebSocket } from "ws";

export type PythTickEvent = {
  pythLazerId: number;
  priceUsd: number;
  confidenceUsd: number | null;
  publishTimeUs: number;
};

const ENDPOINTS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
];

export class PythStream {
  private ws: WebSocket | null = null;
  private listeners: Array<(t: PythTickEvent) => void> = [];
  private feedIds: number[] = [];
  private endpointIdx = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly cfg: {
      accessToken: string;
      feedIds: number[];
      channel: string; // e.g. "fixed_rate@1000ms"
    },
  ) {
    this.feedIds = [...cfg.feedIds];
  }

  on(cb: (t: PythTickEvent) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  setFeedIds(ids: number[]): void {
    this.feedIds = [...ids];
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.subscribe();
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private connect(): void {
    const endpoint = ENDPOINTS[this.endpointIdx % ENDPOINTS.length]!;
    const ws = new WebSocket(endpoint, {
      headers: { authorization: `Bearer ${this.cfg.accessToken}` },
    });
    this.ws = ws;
    ws.on("open", () => {
      this.subscribe();
    });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type?: string;
          parsed?: { priceFeeds?: Array<{
            priceFeedId?: number; id?: number;
            price?: string | number; exponent?: number; expo?: number;
            confidence?: string | number;
            publishTime?: string | number;
          }> };
        };
        if (msg?.type !== "streamUpdated") return;
        const feeds = msg.parsed?.priceFeeds ?? [];
        for (const f of feeds) {
          const expo = Number(f.exponent ?? f.expo ?? 0);
          const priceRaw = Number(f.price ?? 0);
          if (!Number.isFinite(priceRaw) || !Number.isFinite(expo)) continue;
          const priceUsd = priceRaw * Math.pow(10, expo);
          const conf = f.confidence == null ? null : Number(f.confidence) * Math.pow(10, expo);
          const event: PythTickEvent = {
            pythLazerId: Number(f.id ?? f.priceFeedId ?? 0),
            priceUsd,
            confidenceUsd: conf != null && Number.isFinite(conf) ? conf : null,
            publishTimeUs: Number(f.publishTime ?? 0),
          };
          for (const l of this.listeners) l(event);
        }
      } catch {
        // ignore parse errors
      }
    });
    ws.on("close", () => this.scheduleReconnect());
    ws.on("error", () => {
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.feedIds.length === 0) return;
    const payload = {
      type: "subscribe",
      subscriptionId: 1,
      priceFeedIds: this.feedIds,
      properties: ["price", "exponent", "confidence", "publishTime"],
      formats: ["evm", "json"],
      channel: this.cfg.channel,
    };
    this.ws.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.endpointIdx += 1;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 1000);
  }
}
