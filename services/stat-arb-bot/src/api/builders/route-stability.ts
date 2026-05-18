/** Adapter from jupiter_quotes DB rows to the market-core route-stability
 *  aggregator input. */

import type { JupiterQuoteRow } from "@sotama/db";
import type { RouteStabilityQuoteRow } from "@sotama/market-core";

export function toRouteStabilityRow(row: JupiterQuoteRow): RouteStabilityQuoteRow {
  return {
    side: row.side,
    sizeUsd: row.sizeUsd,
    receivedAtMs: row.receivedAt.getTime(),
    router: row.router,
    status: row.status,
    requestMs: row.requestMs,
    priceImpactPct: row.priceImpactPct,
    expiresAtMs: row.expiresAt == null ? null : row.expiresAt.getTime(),
    contextSlot: row.contextSlot ?? null,
  };
}
