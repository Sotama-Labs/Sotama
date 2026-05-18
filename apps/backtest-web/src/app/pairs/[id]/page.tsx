import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getPair,
  basisHistory,
  latestBasisPerKey,
  latestHeartbeat,
} from "@sotama/db";
import { BrandMark, Card, FreshnessDot, levelForAgeMs } from "@sotama/ui";
import type { BasisObservationRow } from "@sotama/db";

export const dynamic = "force-dynamic";

function fmtRatio(v: number | null): string {
  return v == null ? "—" : `${v.toFixed(4)}×`;
}
function fmtBps(v: number | null, signed: boolean = true): string {
  if (v == null) return "—";
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} bps`;
}
function favorableColor(kind: "buy" | "sell", ratio: number | null): string {
  if (ratio == null) return "var(--label-tertiary)";
  const favorable = kind === "buy" ? ratio < 1 : ratio > 1;
  return favorable ? "var(--green)" : "var(--red)";
}

export default async function PairDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const pair = await getPair(id);
  if (!pair) notFound();

  const sinceMs = Date.now() - 24 * 3600 * 1000;
  const [latest, hb, buyHistorySamples, sellHistorySamples] = await Promise.all([
    latestBasisPerKey({ withinMs: 5 * 60_000 }),
    latestHeartbeat(),
    pair.directions.includes("buy_tokenized") && pair.sizesUsd[0] != null
      ? basisHistory({ pairId: id, side: "buy_tokenized", sizeUsd: pair.sizesUsd[0], sinceMs })
      : Promise.resolve([]),
    pair.directions.includes("sell_tokenized") && pair.sizesUsd[0] != null
      ? basisHistory({ pairId: id, side: "sell_tokenized", sizeUsd: pair.sizesUsd[0], sinceMs })
      : Promise.resolve([]),
  ]);

  const forPair = latest.filter((b) => b.pairId === id);
  const buyBySize = new Map<number, BasisObservationRow>();
  const sellBySize = new Map<number, BasisObservationRow>();
  for (const b of forPair) {
    (b.side === "buy_tokenized" ? buyBySize : sellBySize).set(b.sizeUsd, b);
  }

  const { bestBuy, bestSell, bestSpread } = (() => {
    let bestBuy: { ratio: number; sizeUsd: number; netBps: number; observedAt: Date } | null = null;
    for (const b of buyBySize.values()) {
      if (b.basePriceUsd <= 0) continue;
      const ratio = b.tokenPriceUsd / b.basePriceUsd;
      if (!bestBuy || ratio < bestBuy.ratio) {
        bestBuy = { ratio, sizeUsd: b.sizeUsd, netBps: b.netBps, observedAt: b.observedAt };
      }
    }
    let bestSell: { ratio: number; sizeUsd: number; netBps: number; observedAt: Date } | null = null;
    for (const b of sellBySize.values()) {
      if (b.basePriceUsd <= 0) continue;
      const ratio = b.tokenPriceUsd / b.basePriceUsd;
      if (!bestSell || ratio > bestSell.ratio) {
        bestSell = { ratio, sizeUsd: b.sizeUsd, netBps: b.netBps, observedAt: b.observedAt };
      }
    }
    let bestSpread: { spreadBps: number; sizeUsd: number } | null = null;
    for (const [size, buyRow] of buyBySize) {
      const sellRow = sellBySize.get(size);
      if (!sellRow) continue;
      const mid = (buyRow.tokenPriceUsd + sellRow.tokenPriceUsd) / 2;
      if (mid <= 0) continue;
      const spreadBps = ((buyRow.tokenPriceUsd - sellRow.tokenPriceUsd) / mid) * 10000;
      if (!bestSpread || Math.abs(spreadBps) < Math.abs(bestSpread.spreadBps)) {
        bestSpread = { spreadBps, sizeUsd: size };
      }
    }
    return { bestBuy, bestSell, bestSpread };
  })();

  const ageMs = (() => {
    const ages: number[] = [];
    if (bestBuy) ages.push(Date.now() - bestBuy.observedAt.getTime());
    if (bestSell) ages.push(Date.now() - bestSell.observedAt.getTime());
    return ages.length === 0 ? null : Math.min(...ages);
  })();
  const level = levelForAgeMs(ageMs);

  const obsCount = buyHistorySamples.length + sellHistorySamples.length;
  const showBuy = pair.directions.includes("buy_tokenized");
  const showSell = pair.directions.includes("sell_tokenized");
  const showSpread = showBuy && showSell && bestSpread !== null;

  return (
    <main className="bt-shell">
      <header className="bt-header">
        <Link href="/" style={{ textDecoration: "none" }}>
          <BrandMark subtitle="Backtest" />
        </Link>
        <Link
          href="/"
          className="hig-footnote"
          style={{ color: "var(--accent)", textDecoration: "none" }}
        >
          ← All pairs
        </Link>
      </header>

      <section style={{ marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1 className="hig-title-1" style={{ margin: 0 }}>{pair.label}</h1>
          <FreshnessDot ageMs={ageMs} />
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            {level === "live" ? "live" : level === "warm" ? "lagging" : level === "stale" ? "stale" : "no data"}
          </span>
        </div>
        <p className="hig-subheadline" style={{ color: "var(--label-secondary)", margin: "0.25rem 0 0" }}>
          {pair.base.pythSymbol} · {pair.tokenized.symbol} ({pair.tokenized.mint.slice(0, 6)}…{pair.tokenized.mint.slice(-4)}) · {pair.quote.symbol}
        </p>
      </section>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: "0.875rem",
          marginBottom: "1.5rem",
        }}
      >
        {showBuy ? (
          <Card>
            <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Best buy ratio {bestBuy ? `· $${bestBuy.sizeUsd.toLocaleString()}` : ""}
            </div>
            <div
              className="hig-title-3 bt-num"
              style={{ marginTop: 4, color: favorableColor("buy", bestBuy?.ratio ?? null) }}
            >
              {fmtRatio(bestBuy?.ratio ?? null)}
            </div>
            <div className="hig-caption-1 bt-num" style={{ color: "var(--label-tertiary)", marginTop: 2 }}>
              {fmtBps(bestBuy?.netBps ?? null)}
            </div>
          </Card>
        ) : null}
        {showSell ? (
          <Card>
            <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Best sell ratio {bestSell ? `· $${bestSell.sizeUsd.toLocaleString()}` : ""}
            </div>
            <div
              className="hig-title-3 bt-num"
              style={{ marginTop: 4, color: favorableColor("sell", bestSell?.ratio ?? null) }}
            >
              {fmtRatio(bestSell?.ratio ?? null)}
            </div>
            <div className="hig-caption-1 bt-num" style={{ color: "var(--label-tertiary)", marginTop: 2 }}>
              {fmtBps(bestSell?.netBps ?? null)}
            </div>
          </Card>
        ) : null}
        {showSpread ? (
          <Card>
            <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Best spread · ${bestSpread!.sizeUsd.toLocaleString()}
            </div>
            <div
              className="hig-title-3 bt-num"
              style={{
                marginTop: 4,
                color: bestSpread!.spreadBps < 0 ? "var(--green)" : "var(--label-primary)",
              }}
            >
              {fmtBps(bestSpread!.spreadBps, bestSpread!.spreadBps < 0)}
            </div>
            <div className="hig-caption-1 bt-num" style={{ color: "var(--label-tertiary)", marginTop: 2 }}>
              round-trip cost
            </div>
          </Card>
        ) : null}
        <Card>
          <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Sizes (USD)</div>
          <div className="hig-headline bt-num" style={{ marginTop: 4 }}>
            {pair.sizesUsd.map((s) => `$${s.toLocaleString()}`).join(" · ")}
          </div>
          <div className="hig-caption-1" style={{ color: "var(--label-tertiary)", marginTop: 2 }}>
            min net edge {pair.minNetEdgeBps} bps · {pair.enabled ? "enabled" : "disabled"}
          </div>
        </Card>
        <Card>
          <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Observations (24h)</div>
          <div className="hig-headline bt-num" style={{ marginTop: 4 }}>{obsCount.toLocaleString()}</div>
        </Card>
      </div>

      {obsCount === 0 ? (
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>Newly added — collecting data</p>
          <p className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}>
            Quote surface, charts, and profitability metrics populate as the bot streams quotes.
          </p>
        </div>
      ) : (
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>Quote surface and charts coming next</p>
          <p className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}>
            {obsCount.toLocaleString()} basis observations stored. Per-size quote surface, basis chart with
            threshold overlay, cumulative PnL, drawdown, and edge histogram land in the next iteration.
          </p>
        </div>
      )}

      <footer style={{ marginTop: "2rem" }}>
        <p className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
          Bot last heartbeat: {hb ? new Date(hb.observedAt).toISOString() : "—"}
        </p>
      </footer>
    </main>
  );
}
