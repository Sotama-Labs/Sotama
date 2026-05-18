/** HTTP read API for the bot.
 *
 *  The Vercel dashboard fetches these endpoints over HTTPS; the bot is the
 *  only process with private-network access to Fly Postgres. All endpoints
 *  are read-only. Treat this as internal strategy data; production access
 *  should be restricted by the dashboard and hosting layer before exposing
 *  detailed diagnostics outside the owner/admin context. */

import http from "node:http";
import type { CostInputsBps, SchedulerTelemetryDto } from "@sotama/market-core";
import { applyCommonHeaders, normalizePath, sendJson } from "./http";
import { handleHealth } from "./handlers/health";
import { handleDashboard } from "./handlers/dashboard";
import { handlePairDetail } from "./handlers/pair-detail";

export type ApiServerOptions = {
  port: number;
  costInputsBps: CostInputsBps;
  /** Origin allow-list for CORS. `*` is permissive (V1 default). Set to the
   *  dashboard's origin in prod if we ever serve sensitive data. */
  corsOrigin?: string;
  /** Optional provider returning the current scheduler telemetry snapshot. */
  schedulerTelemetry?: () => SchedulerTelemetryDto | null;
  /** Optional override for the route-failure haircut in cost scenarios. */
  routeFailureHaircutBps?: number;
};

export function createApiServer(opts: ApiServerOptions): http.Server {
  const corsOrigin = opts.corsOrigin ?? "*";
  const schedulerTelemetry = opts.schedulerTelemetry ?? (() => null);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, {
      corsOrigin,
      costInputsBps: opts.costInputsBps,
      schedulerTelemetry,
      routeFailureHaircutBps: opts.routeFailureHaircutBps,
    }).catch((e) => {
      try {
        sendJson(res, 500, { error: String(e?.message ?? e) });
      } catch {
        /* socket already closed */
      }
    });
  });
  server.listen(opts.port);
  return server;
}

type RequestContext = {
  corsOrigin: string;
  costInputsBps: CostInputsBps;
  schedulerTelemetry: () => SchedulerTelemetryDto | null;
  routeFailureHaircutBps?: number;
};

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  applyCommonHeaders(res, ctx.corsOrigin);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  const { path } = normalizePath(req);

  if (path === "/api/health") {
    return handleHealth(res, ctx.schedulerTelemetry());
  }
  if (path === "/api/dashboard") {
    return handleDashboard(res, {}, ctx.schedulerTelemetry());
  }
  const pairMatch = path.match(/^\/api\/pairs\/([^/]+)$/);
  if (pairMatch) {
    return handlePairDetail(res, decodeURIComponent(pairMatch[1]!), {
      costInputsBps: ctx.costInputsBps,
      routeFailureHaircutBps: ctx.routeFailureHaircutBps,
    });
  }

  sendJson(res, 404, { error: "not found", path });
}
