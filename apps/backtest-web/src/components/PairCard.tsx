import Link from "next/link";
import { Card, FreshnessDot, levelForAgeMs } from "@sotama/ui";
import type { BestSide, BestSpread, PairPanel } from "@/lib/dashboard";

function fmtRatio(v: number): string {
  // 4 decimal places resolves to 1bp — appropriate for stat-arb basis.
  return `${v.toFixed(4)}×`;
}

function fmtBpsSigned(v: number): string {
  const s = v > 0 ? "+" : "";
  return `${s}${v.toFixed(1)} bps`;
}

function fmtBpsUnsigned(v: number): string {
  return `${v.toFixed(1)} bps`;
}

function favorableColor(kind: "buy" | "sell", ratio: number): string {
  const favorable = kind === "buy" ? ratio < 1 : ratio > 1;
  return favorable ? "var(--green)" : "var(--red)";
}

function RatioRow({
  label,
  entry,
  kind,
}: {
  label: string;
  entry: BestSide | null;
  kind: "buy" | "sell";
}) {
  if (!entry) {
    return (
      <div className="bt-stat-row">
        <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
          {label}
        </span>
        <span className="hig-callout bt-num" style={{ color: "var(--label-tertiary)" }}>
          —
        </span>
      </div>
    );
  }
  return (
    <div className="bt-stat-row">
      <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
        {label} <span style={{ color: "var(--label-tertiary)" }}>· ${entry.sizeUsd.toLocaleString()}</span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
        <span
          className="hig-callout bt-num"
          style={{ color: favorableColor(kind, entry.ratio), fontWeight: 600 }}
        >
          {fmtRatio(entry.ratio)}
        </span>
        <span className="hig-caption-1 bt-num" style={{ color: "var(--label-tertiary)" }}>
          {fmtBpsSigned(entry.netBps)}
        </span>
      </span>
    </div>
  );
}

function SpreadRow({ spread }: { spread: BestSpread }) {
  // Spread is normally positive (Jupiter quotes buy > sell). Negative spread
  // = sell quote richer than buy quote at the same size — an instantaneous
  // crossing opportunity that should never persist; flag green when seen.
  const color =
    spread.spreadBps < 0 ? "var(--green)" : "var(--label-primary)";
  return (
    <div className="bt-stat-row">
      <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
        Spread <span style={{ color: "var(--label-tertiary)" }}>· ${spread.sizeUsd.toLocaleString()}</span>
      </span>
      <span
        className="hig-callout bt-num"
        style={{ color, fontWeight: 600 }}
      >
        {spread.spreadBps < 0 ? fmtBpsSigned(spread.spreadBps) : fmtBpsUnsigned(spread.spreadBps)}
      </span>
    </div>
  );
}

export function PairCard({ panel }: { panel: PairPanel }) {
  const { pair, bestBuy, bestSell, bestSpread, quoteAgeMs } = panel;
  const level = levelForAgeMs(quoteAgeMs);
  const showBuy = pair.directions.includes("buy_tokenized");
  const showSell = pair.directions.includes("sell_tokenized");
  const showSpread = showBuy && showSell && bestSpread !== null;

  return (
    <Link
      href={`/pairs/${encodeURIComponent(pair.id)}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <Card interactive>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span className="hig-headline">{pair.label}</span>
            <FreshnessDot ageMs={quoteAgeMs} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {showBuy ? <RatioRow label="Best buy" entry={bestBuy} kind="buy" /> : null}
            {showSell ? <RatioRow label="Best sell" entry={bestSell} kind="sell" /> : null}
            {showSpread ? <SpreadRow spread={bestSpread} /> : null}
            <div className="bt-stat-row">
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {pair.enabled ? "enabled" : "disabled"} · {pair.sizesUsd.length} size
                {pair.sizesUsd.length === 1 ? "" : "s"}
              </span>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {level === "live"
                  ? "live"
                  : level === "warm"
                  ? "lagging"
                  : level === "stale"
                  ? "stale"
                  : "no data"}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}
