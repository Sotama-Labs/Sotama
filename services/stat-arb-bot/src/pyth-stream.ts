/** Pyth Lazer WebSocket client (raw JSON-RPC, no SDK dependency).
 *
 * Production mode keeps one connection open to every public Lazer endpoint and
 * deduplicates updates client-side. Missing a few seconds during volatility is
 * exactly how a stat-arb bot invents unfillable edge, so endpoint health is
 * tracked independently and written into bot heartbeats.
 */

import { WebSocket } from "ws";

export type PythTickEvent = {
  pythLazerId: number;
  priceUsd: number;
  confidenceUsd: number | null;
  streamTimestampUs: number;
  feedUpdateTimestampUs: number;
  marketSession: string | null;
  freshnessLagMs: number;
  isFresh: boolean;
};

export type LazerEndpointHealth = {
  endpoint: string;
  connected: boolean;
  lastUpdateAgeMs: number | null;
  reconnectCount: number;
  invalidFeedCount: number;
};

export type LazerHealthSnapshot = {
  activeEndpointCount: number;
  endpoints: LazerEndpointHealth[];
};

const ENDPOINTS = [
  "wss://pyth-lazer-0.dourolabs.app/v1/stream",
  "wss://pyth-lazer-1.dourolabs.app/v1/stream",
  "wss://pyth-lazer-2.dourolabs.app/v1/stream",
];

const DEDUPE_TTL_MS = 60_000;

type EndpointState = {
  endpoint: string;
  ws: WebSocket | null;
  reconnectTimer: NodeJS.Timeout | null;
  keepaliveTimer: NodeJS.Timeout | null;
  reconnectBackoffMs: number;
  reconnectCount: number;
  invalidFeedCount: number;
  lastUpdateAtMs: number | null;
  connected: boolean;
  firstStreamUpdateLogged: boolean;
};

export class PythStream {
  private listeners: Array<(t: PythTickEvent) => void> = [];
  private feedIds: number[] = [];
  private stopped = false;
  private readonly endpoints = ENDPOINTS.map((endpoint) => this.createEndpointState(endpoint));
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly cfg: {
      accessToken: string;
      feedIds: number[];
      channel: string;
      maxFreshnessLagMs?: number;
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
    if (!changed) return;
    console.log(`[lazer] feed ids updated: [${next.join(",")}]`);
    // Lazer subscription changes require reconnecting the whole subscription.
    for (const state of this.endpoints) this.closeSocket(state);
    if (!this.stopped && this.feedIds.length > 0) {
      for (const state of this.endpoints) {
        if (!state.ws && !state.reconnectTimer) this.connect(state);
      }
    }
  }

  start(): void {
    this.stopped = false;
    if (this.feedIds.length === 0) {
      console.log("[lazer] no feeds configured yet; waiting for pair loader");
      return;
    }
    for (const state of this.endpoints) this.connect(state);
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.endpoints) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
      this.closeSocket(state);
    }
  }

  health(nowMs: number = Date.now()): LazerHealthSnapshot {
    const endpoints = this.endpoints.map((state) => ({
      endpoint: state.endpoint,
      connected: state.connected,
      lastUpdateAgeMs:
        state.lastUpdateAtMs == null ? null : Math.max(0, nowMs - state.lastUpdateAtMs),
      reconnectCount: state.reconnectCount,
      invalidFeedCount: state.invalidFeedCount,
    }));
    return {
      activeEndpointCount: endpoints.filter((e) => e.connected).length,
      endpoints,
    };
  }

  private createEndpointState(endpoint: string): EndpointState {
    return {
      endpoint,
      ws: null,
      reconnectTimer: null,
      keepaliveTimer: null,
      reconnectBackoffMs: 1000,
      reconnectCount: 0,
      invalidFeedCount: 0,
      lastUpdateAtMs: null,
      connected: false,
      firstStreamUpdateLogged: false,
    };
  }

  private connect(state: EndpointState): void {
    if (this.stopped) return;
    console.log(`[lazer] connecting to ${state.endpoint}`);
    const ws = new WebSocket(state.endpoint, {
      headers: { authorization: `Bearer ${this.cfg.accessToken}` },
    });
    state.ws = ws;

    ws.on("open", () => {
      console.log(`[lazer] connected endpoint=${state.endpoint} feeds=[${this.feedIds.join(",")}]`);
      state.connected = true;
      state.reconnectBackoffMs = 1000;
      state.firstStreamUpdateLogged = false;
      this.subscribe(state);
      if (state.keepaliveTimer) clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          try { state.ws.ping(); } catch { /* ignore */ }
        }
      }, 20_000);
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as any;
        this.handleMessage(state, msg);
      } catch (e) {
        console.error(`[lazer] parse error endpoint=${state.endpoint}`, e);
      }
    });

    ws.on("close", (code, reason) => {
      console.warn(
        `[lazer] closed endpoint=${state.endpoint} code=${code} reason=${reason?.toString() ?? ""}`,
      );
      state.connected = false;
      if (state.keepaliveTimer) clearInterval(state.keepaliveTimer);
      state.keepaliveTimer = null;
      this.scheduleReconnect(state);
    });

    ws.on("error", (err: Error) => {
      console.error(`[lazer] socket error endpoint=${state.endpoint}`, err?.message ?? err);
      try { ws.close(); } catch { /* ignore */ }
    });
  }

  private closeSocket(state: EndpointState): void {
    if (state.keepaliveTimer) clearInterval(state.keepaliveTimer);
    state.keepaliveTimer = null;
    if (state.ws) {
      const ws = state.ws;
      state.ws = null;
      ws.removeAllListeners();
      ws.on("error", () => {
        /* swallow close-before-open errors from intentionally replaced sockets */
      });
      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close();
      } catch {
        /* ignore */
      }
    }
    state.connected = false;
    if (!this.stopped) this.scheduleReconnect(state);
  }

  private handleMessage(state: EndpointState, msg: any): void {
    const type = msg?.type;
    switch (type) {
      case "subscribed": {
        const ids: number[] = msg.subscribedFeedIds ?? [];
        console.log(
          `[lazer] subscribed endpoint=${state.endpoint} subscriptionId=${msg.subscriptionId} feeds=[${ids.join(",")}]`,
        );
        return;
      }
      case "subscribedWithInvalidFeedIdsIgnored": {
        const accepted: number[] = msg.subscribedFeedIds ?? [];
        const ignored = msg.ignoredInvalidFeedIds ?? {};
        const invalidCount = Object.keys(ignored).length;
        state.invalidFeedCount += invalidCount;
        console.warn(
          `[lazer] partial subscribe endpoint=${state.endpoint} accepted=[${accepted.join(",")}] ignored=${JSON.stringify(ignored)}`,
        );
        return;
      }
      case "subscriptionError":
      case "error": {
        console.error(
          `[lazer] server ${type} endpoint=${state.endpoint}: ${msg.error ?? JSON.stringify(msg)}`,
        );
        return;
      }
      case "unsubscribed": {
        console.log(`[lazer] unsubscribed endpoint=${state.endpoint} subscriptionId=${msg.subscriptionId}`);
        return;
      }
      case "streamUpdated": {
        const parsed = msg?.parsed;
        const feeds: any[] = parsed?.priceFeeds ?? [];
        const streamTimestampUs = Number(parsed?.timestampUs ?? 0);
        state.lastUpdateAtMs = Date.now();
        if (!state.firstStreamUpdateLogged) {
          state.firstStreamUpdateLogged = true;
          console.log(
            `[lazer] first streamUpdate endpoint=${state.endpoint}: feeds=${feeds.length} sample=${JSON.stringify(feeds[0] ?? {})}`,
          );
        }
        for (const f of feeds) {
          const event = this.toEvent(f, streamTimestampUs);
          if (!event || this.wasSeen(event)) continue;
          for (const l of this.listeners) l(event);
        }
        return;
      }
      default: {
        console.warn(`[lazer] unknown message type endpoint=${state.endpoint}: ${type ?? "<missing>"}`);
      }
    }
  }

  private toEvent(f: any, streamTimestampUs: number): PythTickEvent | null {
    const expo = Number(f.exponent ?? 0);
    if (!Number.isFinite(expo)) return null;

    const priceRaw =
      typeof f.price === "string" ? Number(f.price) : Number(f.price);
    if (!Number.isFinite(priceRaw) || priceRaw === 0) return null;

    const priceUsd = priceRaw * Math.pow(10, expo);
    const confidenceUsd =
      f.confidence == null ? null : Number(f.confidence) * Math.pow(10, expo);
    const feedUpdateTimestampUs = Number(
      f.feedUpdateTimestamp ?? f.publishTime ?? streamTimestampUs ?? 0,
    );
    const resolvedStreamTimestampUs =
      Number.isFinite(streamTimestampUs) && streamTimestampUs > 0
        ? streamTimestampUs
        : feedUpdateTimestampUs;
    const freshnessLagMs = Math.max(
      0,
      Math.round((resolvedStreamTimestampUs - feedUpdateTimestampUs) / 1000),
    );
    const maxFreshnessLagMs = this.cfg.maxFreshnessLagMs ?? 5_000;

    return {
      pythLazerId: Number(f.priceFeedId ?? f.id ?? 0),
      priceUsd,
      confidenceUsd:
        confidenceUsd == null || !Number.isFinite(confidenceUsd)
          ? null
          : confidenceUsd,
      streamTimestampUs: resolvedStreamTimestampUs,
      feedUpdateTimestampUs,
      marketSession: typeof f.marketSession === "string" ? f.marketSession : null,
      freshnessLagMs,
      isFresh: freshnessLagMs <= maxFreshnessLagMs,
    };
  }

  private wasSeen(event: PythTickEvent): boolean {
    const nowMs = Date.now();
    const key = `${event.pythLazerId}|${event.streamTimestampUs}|${event.feedUpdateTimestampUs}|${event.priceUsd}|${event.marketSession ?? ""}`;
    if (this.seen.has(key)) return true;
    this.seen.set(key, nowMs);
    if (this.seen.size > 10_000) {
      for (const [seenKey, seenAt] of this.seen) {
        if (nowMs - seenAt > DEDUPE_TTL_MS) this.seen.delete(seenKey);
      }
    }
    return false;
  }

  private subscribe(state: EndpointState): void {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (this.feedIds.length === 0) {
      console.log(`[lazer] no feeds to subscribe to endpoint=${state.endpoint}`);
      return;
    }
    const payload = {
      type: "subscribe",
      subscriptionId: 1,
      priceFeedIds: this.feedIds,
      properties: ["price", "exponent", "feedUpdateTimestamp", "marketSession"],
      formats: ["solana"],
      deliveryFormat: "json",
      jsonBinaryEncoding: "base64",
      parsed: true,
      channel: this.cfg.channel,
      ignoreInvalidFeeds: true,
    };
    console.log(
      `[lazer] -> subscribe endpoint=${state.endpoint} channel=${this.cfg.channel} feeds=[${this.feedIds.join(",")}]`,
    );
    state.ws.send(JSON.stringify(payload));
  }

  private scheduleReconnect(state: EndpointState): void {
    if (this.stopped || state.reconnectTimer) return;
    const delay = Math.min(state.reconnectBackoffMs, 60_000);
    state.reconnectBackoffMs = Math.min(state.reconnectBackoffMs * 2, 60_000);
    state.reconnectCount += 1;
    console.log(`[lazer] reconnecting endpoint=${state.endpoint} in ${delay}ms`);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      this.connect(state);
    }, delay);
  }
}
