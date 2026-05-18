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
function fmtUsd(v: number | null | undefined): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(v) >= 100 ? 2 : 4,
  }).format(v);
}
function fmtMs(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v).toLocaleString()} ms`;
}
function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function favorableColor(kind: "buy" | "sell", ratio: number | null | undefined): string {
  if (ratio == null) return "var(--label-tertiary)";
  const favorable = kind === "buy" ? ratio < 1 : ratio > 1;
  return favorable ? "var(--green)" : "var(--red)";
}
function qualityColor(quality: string): string {
  if (quality === "live" || quality === "LIVE_ELIGIBLE") return "var(--green)";
  if (quality === "warm" || quality === "QUOTE_LATENCY_TOO_HIGH") return "var(--orange)";
  if (
    quality === "stale" ||
    quality === "invalid" ||
    quality === "STALE_PYTH" ||
    quality === "STALE_BASIS"
  ) return "var(--red)";
  return "var(--label-tertiary)";
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

  const {
    pair,
    bestBuy,
    bestSell,
    bestSpread,
    quoteAgeMs,
    observationCount24h,
    quoteSurface,
    basisSeries,
    qualityDistribution,
    timeRegimeSummary,
    signalHistory,
    profitability,
  } = detail;
  const level = levelForAgeMs(quoteAgeMs);
  const showBuy = pair.directions.includes("buy_tokenized");
  const showSell = pair.directions.includes("sell_tokenized");
  const showSpread = showBuy && showSell && bestSpread !== null;
  const oldestBasisAgeMs =
    quoteSurface.length === 0
      ? null
      : Math.max(...quoteSurface.map((row) => row.basisAgeMs ?? 0));

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
            {pair.sizesUsd.map((s: number) => `$${s.toLocaleString()}`).join(" · ")}
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
            Quote surface and profitability metrics populate as the bot streams quotes.
          </p>
        </div>
      ) : (
        <div style={{ display: "grid", gap: "1rem" }}>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <div>
                <p className="hig-headline" style={{ margin: 0 }}>Quote surface</p>
                <p className="hig-caption-1" style={{ color: "var(--label-tertiary)", margin: "0.25rem 0 0" }}>
                  Latest executable quote per side and size.
                </p>
              </div>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {quoteSurface.length} live rows
              </span>
            </div>
            <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1040 }}>
                <thead>
                  <tr className="hig-caption-1" style={{ color: "var(--label-tertiary)", textAlign: "left" }}>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Side</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Regime</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Eligibility</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Size</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Token price</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Net edge</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Pyth lag</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Quote</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {quoteSurface.map((row) => (
                    <tr
                      key={`${row.side}-${row.sizeUsd}`}
                      style={{ borderTop: "1px solid var(--separator)" }}
                    >
                      <td className="hig-footnote" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.side === "buy_tokenized" ? "Buy tokenized" : "Sell tokenized"}
                      </td>
                      <td className="hig-caption-1" style={{ padding: "0.65rem 0.35rem", color: "var(--label-secondary)", whiteSpace: "nowrap" }}>
                        {row.timeRegime ?? "—"}
                      </td>
                      <td
                        className="hig-caption-1"
                        title={row.qualityReason}
                        style={{ padding: "0.65rem 0.35rem", color: qualityColor(row.qualityStatus), whiteSpace: "nowrap" }}
                      >
                        {row.qualityStatus}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        ${row.sizeUsd.toLocaleString()}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtUsd(row.tokenPriceUsd)}
                      </td>
                      <td
                        className="hig-footnote bt-num"
                        style={{
                          padding: "0.65rem 0.35rem",
                          color: row.netBps >= pair.minNetEdgeBps ? "var(--green)" : "var(--label-primary)",
                        }}
                      >
                        {fmtBps(row.netBps)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtMs(row.pythFreshnessLagMs)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtMs(row.quoteRequestMs)}
                      </td>
                      <td
                        className="hig-footnote"
                        style={{ padding: "0.65rem 0.35rem", color: qualityColor(row.quality) }}
                      >
                        {row.quality}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <div>
                <p className="hig-headline" style={{ margin: 0 }}>Quote quality distribution</p>
                <p className="hig-caption-1" style={{ color: "var(--label-tertiary)", margin: "0.25rem 0 0" }}>
                  Live eligibility gate across the 24h observation set.
                </p>
              </div>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {qualityDistribution.reduce((sum, row) => sum + row.observationCount, 0).toLocaleString()} rows
              </span>
            </div>
            {qualityDistribution.length === 0 ? (
              <p className="hig-footnote" style={{ color: "var(--label-secondary)", margin: "0.75rem 0 0" }}>
                No quality-gated observations in the current window.
              </p>
            ) : (
              <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                  <thead>
                    <tr className="hig-caption-1" style={{ color: "var(--label-tertiary)", textAlign: "left" }}>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Status</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Rows</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {qualityDistribution.map((row) => (
                      <tr key={row.qualityStatus} style={{ borderTop: "1px solid var(--separator)" }}>
                        <td className="hig-caption-1" style={{ padding: "0.65rem 0.35rem", color: qualityColor(row.qualityStatus), whiteSpace: "nowrap" }}>
                          {row.qualityStatus}
                        </td>
                        <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                          {row.observationCount.toLocaleString()}
                        </td>
                        <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                          {fmtPct(row.observationPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <div>
                <p className="hig-headline" style={{ margin: 0 }}>Time regime comparison</p>
                <p className="hig-caption-1" style={{ color: "var(--label-tertiary)", margin: "0.25rem 0 0" }}>
                  24h basis observations grouped by session/state.
                </p>
              </div>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {timeRegimeSummary.reduce((sum, row) => sum + row.observationCount, 0).toLocaleString()} rows
              </span>
            </div>
            <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1040 }}>
                <thead>
                  <tr className="hig-caption-1" style={{ color: "var(--label-tertiary)", textAlign: "left" }}>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Regime</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Obs</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Live</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Buy / sell</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Avg gross</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Avg net</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Max net</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Min net</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Quote</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Pyth lag</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Basis age</th>
                  </tr>
                </thead>
                <tbody>
                  {timeRegimeSummary.map((row) => (
                    <tr key={row.timeRegime} style={{ borderTop: "1px solid var(--separator)" }}>
                      <td className="hig-caption-1" style={{ padding: "0.65rem 0.35rem", color: "var(--label-secondary)", whiteSpace: "nowrap" }}>
                        {row.timeRegime}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.observationCount.toLocaleString()}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtPct(row.livePct)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.buyCount.toLocaleString()} / {row.sellCount.toLocaleString()}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtBps(row.avgGrossBps)}
                      </td>
                      <td
                        className="hig-footnote bt-num"
                        style={{
                          padding: "0.65rem 0.35rem",
                          color: (row.avgNetBps ?? 0) > 0 ? "var(--green)" : (row.avgNetBps ?? 0) < 0 ? "var(--red)" : "var(--label-primary)",
                        }}
                      >
                        {fmtBps(row.avgNetBps)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtBps(row.maxNetBps)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtBps(row.minNetBps)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtMs(row.avgQuoteRequestMs)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtMs(row.avgPythFreshnessLagMs)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtMs(row.avgBasisAgeMs)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: "0.875rem",
            }}
          >
            <Card>
              <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Paper PnL (7d)</div>
              <div
                className="hig-title-3 bt-num"
                style={{
                  marginTop: 4,
                  color: profitability.cumulativePnlUsd > 0 ? "var(--green)" : profitability.cumulativePnlUsd < 0 ? "var(--red)" : "var(--label-primary)",
                }}
              >
                {fmtUsd(profitability.cumulativePnlUsd)}
              </div>
              <div className="hig-caption-1" style={{ color: "var(--label-tertiary)", marginTop: 2 }}>
                spot inventory only · no synthetic shorts
              </div>
            </Card>
            <Card>
              <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Win rate</div>
              <div className="hig-title-3 bt-num" style={{ marginTop: 4 }}>
                {(profitability.winRate * 100).toFixed(1)}%
              </div>
              <div className="hig-caption-1" style={{ color: "var(--label-tertiary)", marginTop: 2 }}>
                {profitability.signalCount.toLocaleString()} closed signals
              </div>
            </Card>
            <Card>
              <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Max drawdown</div>
              <div className="hig-title-3 bt-num" style={{ marginTop: 4 }}>
                {fmtUsd(profitability.maxDrawdownUsd)}
              </div>
              <div className="hig-caption-1" style={{ color: "var(--label-tertiary)", marginTop: 2 }}>
                avg hold {profitability.avgHoldSeconds.toFixed(0)}s
              </div>
            </Card>
          </div>

          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <p className="hig-headline" style={{ margin: 0 }}>Signal history</p>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {signalHistory.length} recent
              </span>
            </div>
            {signalHistory.length === 0 ? (
              <p className="hig-footnote" style={{ color: "var(--label-secondary)", margin: "0.75rem 0 0" }}>
                No closed spot positions in the current window.
              </p>
            ) : (
              <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 680 }}>
                  <thead>
                    <tr className="hig-caption-1" style={{ color: "var(--label-tertiary)", textAlign: "left" }}>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Exit</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Size</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Entry edge</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Exit edge</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>PnL</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signalHistory.map((s) => (
                      <tr key={s.id} style={{ borderTop: "1px solid var(--separator)" }}>
                        <td className="hig-footnote" style={{ padding: "0.65rem 0.35rem" }}>
                          {new Date(s.exitAt).toLocaleString()}
                        </td>
                        <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                          ${s.sizeUsd.toLocaleString()}
                        </td>
                        <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                          {fmtBps(s.entryEdgeBps)}
                        </td>
                        <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                          {fmtBps(s.exitEdgeBps)}
                        </td>
                        <td
                          className="hig-footnote bt-num"
                          style={{
                            padding: "0.65rem 0.35rem",
                            color: s.pnlUsd > 0 ? "var(--green)" : s.pnlUsd < 0 ? "var(--red)" : "var(--label-primary)",
                          }}
                        >
                          {fmtUsd(s.pnlUsd)}
                        </td>
                        <td className="hig-footnote" style={{ padding: "0.65rem 0.35rem" }}>
                          {s.exitReason ?? s.outcome}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <p className="hig-headline" style={{ margin: 0 }}>Data quality</p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "0.75rem",
                marginTop: "0.75rem",
              }}
            >
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Series points</div>
                <div className="hig-headline bt-num">{basisSeries.length.toLocaleString()}</div>
              </div>
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Live rows</div>
                <div className="hig-headline bt-num">
                  {quoteSurface.filter((row) => row.quality === "live").length.toLocaleString()} / {quoteSurface.length}
                </div>
              </div>
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Oldest basis age</div>
                <div className="hig-headline bt-num">{fmtMs(oldestBasisAgeMs)}</div>
              </div>
            </div>
          </Card>
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
