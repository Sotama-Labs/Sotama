import Link from "next/link";
import { Card, FreshnessDot, levelForAgeMs } from "@sotama/ui";
import type { PairPanel } from "@/lib/dashboard";

function fmtBps(v: number | null): string {
  if (v == null) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} bps`;
}

function bpsColor(v: number | null): string {
  if (v == null) return "var(--label-tertiary)";
  if (v > 0) return "var(--green)";
  if (v < 0) return "var(--red)";
  return "var(--label-secondary)";
}

export function PairCard({ panel }: { panel: PairPanel }) {
  const { pair, bestBuyNetBps, bestSellNetBps, quoteAgeMs } = panel;
  const level = levelForAgeMs(quoteAgeMs);
  return (
    <Link
      href={`/pairs/${encodeURIComponent(pair.id)}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <Card interactive>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <span className="hig-headline">{pair.label}</span>
            <FreshnessDot ageMs={quoteAgeMs} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div className="bt-stat-row">
              <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
                Best buy edge
              </span>
              <span className="hig-callout bt-num" style={{ color: bpsColor(bestBuyNetBps), fontWeight: 600 }}>
                {fmtBps(bestBuyNetBps)}
              </span>
            </div>
            <div className="bt-stat-row">
              <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
                Best sell edge
              </span>
              <span className="hig-callout bt-num" style={{ color: bpsColor(bestSellNetBps), fontWeight: 600 }}>
                {fmtBps(bestSellNetBps)}
              </span>
            </div>
            <div className="bt-stat-row">
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {pair.enabled ? "enabled" : "disabled"} · {pair.sizesUsd.length} size{pair.sizesUsd.length === 1 ? "" : "s"}
              </span>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {level === "live" ? "live" : level === "warm" ? "lagging" : level === "stale" ? "stale" : "no data"}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}
