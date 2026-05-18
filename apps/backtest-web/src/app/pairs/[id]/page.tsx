import { notFound } from "next/navigation";
import Link from "next/link";
import { getPair, basisHistory, latestHeartbeat } from "@sotama/db";
import { BrandMark, Card } from "@sotama/ui";

export const dynamic = "force-dynamic";

export default async function PairDetailPage(
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const pair = await getPair(id);
  if (!pair) notFound();

  const sinceMs = Date.now() - 24 * 3600 * 1000;
  const [buyHistorySamples, sellHistorySamples, hb] = await Promise.all([
    pair.directions.includes("buy_tokenized") && pair.sizesUsd[0] != null
      ? basisHistory({ pairId: id, side: "buy_tokenized", sizeUsd: pair.sizesUsd[0], sinceMs })
      : Promise.resolve([]),
    pair.directions.includes("sell_tokenized") && pair.sizesUsd[0] != null
      ? basisHistory({ pairId: id, side: "sell_tokenized", sizeUsd: pair.sizesUsd[0], sinceMs })
      : Promise.resolve([]),
    latestHeartbeat(),
  ]);

  const obsCount = buyHistorySamples.length + sellHistorySamples.length;

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
        <h1 className="hig-title-1" style={{ margin: 0 }}>{pair.label}</h1>
        <p className="hig-subheadline" style={{ color: "var(--label-secondary)", margin: "0.25rem 0 0" }}>
          {pair.base.pythSymbol} · {pair.tokenized.symbol} ({pair.tokenized.mint.slice(0, 6)}…{pair.tokenized.mint.slice(-4)}) · {pair.quote.symbol}
        </p>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "0.875rem", marginBottom: "1.5rem" }}>
        <Card>
          <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Status</div>
          <div className="hig-headline" style={{ marginTop: 4 }}>
            {pair.enabled ? "Enabled" : "Disabled"}
          </div>
        </Card>
        <Card>
          <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Sizes (USD)</div>
          <div className="hig-headline bt-num" style={{ marginTop: 4 }}>
            {pair.sizesUsd.map((s) => `$${s.toLocaleString()}`).join(" · ")}
          </div>
        </Card>
        <Card>
          <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Min net edge</div>
          <div className="hig-headline bt-num" style={{ marginTop: 4 }}>{pair.minNetEdgeBps} bps</div>
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
            Charts, quote surface, and profitability metrics will populate as the bot streams quotes.
          </p>
        </div>
      ) : (
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>Detail view coming next</p>
          <p className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}>
            {obsCount.toLocaleString()} basis observations stored. Quote surface, recharts views, and
            profitability stats land in the next iteration.
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
