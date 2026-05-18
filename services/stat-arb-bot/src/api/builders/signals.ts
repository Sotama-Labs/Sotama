import type { ClosedSignalRow } from "@sotama/db";
import type { SignalHistoryDto } from "@sotama/market-core";

export function toSignalHistory(s: ClosedSignalRow): SignalHistoryDto {
  return {
    id: s.id.toString(),
    sizeUsd: s.sizeUsd,
    entryAt: s.entryAt.toISOString(),
    exitAt: s.exitAt.toISOString(),
    entryEdgeBps: s.entryEdgeBps,
    exitEdgeBps: s.exitEdgeBps,
    pnlUsd: s.pnlUsd,
    outcome: s.outcome,
    exitReason: s.exitReason,
    entryQualityStatus: s.entryQualityStatus,
    exitQualityStatus: s.exitQualityStatus,
  };
}
