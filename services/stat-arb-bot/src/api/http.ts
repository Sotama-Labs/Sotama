/** Tiny HTTP plumbing — CORS, JSON serialization, request parsing. */

import type http from "node:http";

export function applyCommonHeaders(
  res: http.ServerResponse,
  corsOrigin: string,
): void {
  res.setHeader("Access-Control-Allow-Origin", corsOrigin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Cache-Control", "no-store");
}

export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function normalizePath(req: http.IncomingMessage): {
  url: URL;
  path: string;
} {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  return { url, path: url.pathname.replace(/\/+$/, "") || "/" };
}
