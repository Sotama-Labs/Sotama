/** Pyth Lazer WebSocket client (raw JSON-RPC, no SDK dependency).
 *
 *  Protocol mirrors what the keeper's Rust client produces via
 *  `pyth_lazer_protocol::api::WsRequest` (see keeper/src/lazer_watcher.rs).
 *
 *  Subscribe message:
 *    {
 *      "type": "subscribe",
 *      "subscriptionId": 1,
 *      "params": {
 *        "priceFeedIds": [346],
 *        "properties": ["price","exponent","feedUpdateTimestamp"],
 *        "formats": ["solana"],         // required by API; we ignore signed bytes
 *        "deliveryFormat": "json",
 *        "jsonBinaryEncoding": "base64",
 *        "parsed": true,                // returns payload.parsed.priceFeeds
 *        "channel": "fixed_rate@1000ms",
 *        "ignoreInvalidFeeds": true
 *      }
 *    }
 *
 *  Server replies:
 *    {"type": "subscribed", "subscriptionId": 1, "subscribedFeedIds": [346]}
 *    {"type": "streamUpdated", "payload": {"parsed": {"timestampUs": N, "priceFeeds": [...]}}}
 *    {"type": "subscriptionError" | "error", "error": "..."}
 */

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
  "wss://pyth-lazer-2.dourolabs.app/v1/stream",
];

export class PythStream {
  private ws: WebSocket | null = null;
  private listeners: Array<(t: PythTickEvent) => void> = [];
  private feedIds: number[] = [];
  private endpointIdx = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectBackoffMs = 1000;
  private stopped = false;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private firstStreamUpdateLogged = false;

  constructor(
    private readonly cfg: {
      accessToken: string;
      feedIds: number[];
      channel: string;
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
    const next = [...ids];
    const changed =
      next.length !== this.feedIds.length ||
      next.some((id, i) => id !== this.feedIds[i]);
    this.feedIds = next;
    if (changed) {
      console.log(`[lazer] feed ids updated: [${next.join(",")}]`);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.subscribe();
      }
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
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (this.ws) {
      this.ws.removeAllListeners();
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private connect(): void {
    const endpoint = ENDPOINTS[this.endpointIdx % ENDPOINTS.length]!;
    console.log(`[lazer] connecting to ${endpoint}`);
    const ws = new WebSocket(endpoint, {
      headers: { authorization: `Bearer ${this.cfg.accessToken}` },
    });
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[lazer] connected (feeds: [${this.feedIds.join(",")}])`);
      this.reconnectBackoffMs = 1000;
      this.firstStreamUpdateLogged = false;
      this.subscribe();
      // Lazer's Rust client sends a WS Ping every 20s to keep the
      // subscription alive. Without it, the server tends to go quiet
      // even after acknowledging the subscribe.
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try { this.ws.ping(); } catch { /* ignore */ }
        }
      }, 20_000);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as any;
        this.handleMessage(msg);
      } catch (e) {
        console.error("[lazer] parse error", e);
      }
    });

    ws.on("close", (code, reason) => {
      console.warn(`[lazer] closed code=${code} reason=${reason?.toString() ?? ""}`);
      if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
      this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      console.error("[lazer] socket error", err?.message ?? err);
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  private handleMessage(msg: any): void {
    const type = msg?.type;
    switch (type) {
      case "subscribed": {
        const ids: number[] = msg.subscribedFeedIds ?? [];
        console.log(`[lazer] subscribed: subscriptionId=${msg.subscriptionId} feeds=[${ids.join(",")}]`);
        return;
      }
      case "subscribedWithInvalidFeedIdsIgnored": {
        const accepted: number[] = msg.subscribedFeedIds ?? [];
        const ignored = msg.ignoredInvalidFeedIds ?? {};
        console.warn(
          `[lazer] partial subscribe: accepted=[${accepted.join(",")}] ignored=${JSON.stringify(ignored)}`,
        );
        return;
      }
      case "subscriptionError":
      case "error": {
        console.error(`[lazer] server ${type}: ${msg.error ?? JSON.stringify(msg)}`);
        return;
      }
      case "unsubscribed": {
        console.log(`[lazer] unsubscribed: subscriptionId=${msg.subscriptionId}`);
        return;
      }
      case "streamUpdated": {
        // Wire format flattens parsed + per-format payloads to the top
        // level alongside `type` and `subscriptionId`:
        //   { type, subscriptionId, parsed: {...}, solana: {...} }
        // The Rust SDK wraps these under `payload` but the JSON-over-WS
        // protocol does not.
        const parsed = msg?.parsed;
        const feeds: any[] = parsed?.priceFeeds ?? [];
        const fallbackTimestamp = Number(parsed?.timestampUs ?? 0);
        if (!this.firstStreamUpdateLogged) {
          this.firstStreamUpdateLogged = true;
          console.log(`[lazer] first streamUpdate: feeds=${feeds.length} sample=${JSON.stringify(feeds[0] ?? {})}`);
        }
        for (const f of feeds) {
          const event = this.toEvent(f, fallbackTimestamp);
          if (event) {
            for (const l of this.listeners) l(event);
          }
        }
        return;
      }
      default: {
        console.warn(`[lazer] unknown message type: ${type ?? "<missing>"}`);
      }
    }
  }

  private toEvent(f: any, fallbackTimestampUs: number): PythTickEvent | null {
    const expo = Number(f.exponent ?? 0);
    if (!Number.isFinite(expo)) return null;

    // `price` is an i64 mantissa, serialized either as JSON number or string.
    const priceRaw =
      typeof f.price === "string" ? Number(f.price) : Number(f.price);
    if (!Number.isFinite(priceRaw) || priceRaw === 0) return null;

    const priceUsd = priceRaw * Math.pow(10, expo);
    const confidenceUsd =
      f.confidence == null ? null : Number(f.confidence) * Math.pow(10, expo);
    const publishTimeUs = Number(
      f.feedUpdateTimestamp ?? f.publishTime ?? fallbackTimestampUs ?? 0,
    );

    return {
      pythLazerId: Number(f.priceFeedId ?? f.id ?? 0),
      priceUsd,
      confidenceUsd:
        confidenceUsd == null || !Number.isFinite(confidenceUsd)
          ? null
          : confidenceUsd,
      publishTimeUs,
    };
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.feedIds.length === 0) {
      console.log("[lazer] no feeds to subscribe to (waiting for pair loader)");
      return;
    }
    // Lazer's WsRequest serializes with serde(tag = "type") and the
    // SubscribeRequest's `params` is flatten'd, so all subscription
    // fields live at the top level next to `type` and `subscriptionId`.
    const payload = {
      type: "subscribe",
      subscriptionId: 1,
      priceFeedIds: this.feedIds,
      properties: ["price", "exponent", "feedUpdateTimestamp"],
      formats: ["solana"],
      deliveryFormat: "json",
      jsonBinaryEncoding: "base64",
      parsed: true,
      channel: this.cfg.channel,
      ignoreInvalidFeeds: true,
    };
    console.log(
      `[lazer] -> subscribe channel=${this.cfg.channel} feeds=[${this.feedIds.join(",")}]`,
    );
    this.ws.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.endpointIdx += 1;
    if (this.reconnectTimer) return;
    const delay = Math.min(this.reconnectBackoffMs, 60_000);
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * 2, 60_000);
    console.log(`[lazer] reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
