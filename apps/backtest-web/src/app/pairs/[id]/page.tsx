import { notFound } from "next/navigation";
import Link from "next/link";
import { BrandMark, Card, FreshnessDot, levelForAgeMs } from "@sotama/ui";
import { fetchPairDetail, fetchHealth } from "@/lib/bot-api";

export const dynamic = "force-dynamic";

function fmtRatio(v: number | null | undefined): string {
  return v == null ? "—" : `${v.toFixed(4)}×`;
}
function fmtBps(v: number | null | undefined, signed: boolean = true): string {
  if (v == null) return "—";
  const sign = signed && v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)} bps`;
}
function favorableColor(kind: "buy" | "sell", ratio: number | null | undefined): string {
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

  let detail: Awaited<ReturnType<typeof fetchPairDetail>> = null;
  let health: Awaited<ReturnType<typeof fetchHealth>> | null = null;
  let loadError: string | null = null;
  try {
    [detail, health] = await Promise.all([
      fetchPairDetail(id),
      fetchHealth().catch(() => null),
    ]);
  } catch (e: any) {
    loadError = String(e?.message ?? e);
  }
  if (loadError) {
    return (
      <main className="bt-shell">
        <header className="bt-header">
          <Link href="/" style={{ textDecoration: "none" }}>
            <BrandMark subtitle="Backtest" />
          </Link>
        </header>
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>Bot unreachable</p>
          <p className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}>
            {loadError}
          </p>
        </div>
      </main>
    );
  }
  if (!detail) notFound();

  const { pair, bestBuy, bestSell, bestSpread, quoteAgeMs, observationCount24h } = detail;
  const level = levelForAgeMs(quoteAgeMs);
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
          <FreshnessDot ageMs={quoteAgeMs} />
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
          <div className="hig-headline bt-num" style={{ marginTop: 4 }}>{observationCount24h.toLocaleString()}</div>
        </Card>
      </div>

      {observationCount24h === 0 ? (
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
            {observationCount24h.toLocaleString()} basis observations stored. Per-size quote surface, basis chart with
            threshold overlay, cumulative PnL, drawdown, and edge histogram land in the next iteration.
          </p>
        </div>
      )}

      <footer style={{ marginTop: "2rem" }}>
        <p className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
          Bot last heartbeat: {health?.heartbeat?.observedAt ?? "—"}
        </p>
      </footer>
    </main>
  );
}
