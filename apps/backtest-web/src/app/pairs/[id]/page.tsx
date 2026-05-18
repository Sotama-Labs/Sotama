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
function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / (60 * 60_000))}h`;
}
function fmtPct(v: number | null | undefined): string {
  return v == null ? "—" : `${(v * 100).toFixed(1)}%`;
}
function fmtReturnPct(v: number | null | undefined): string {
  if (v == null) return "—";
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(Math.abs(pct) >= 100 ? 1 : 2)}%`;
}
function fmtApr(v: number | null | undefined): string {
  if (v == null) return "—";
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  const digits = Math.abs(pct) >= 1000 ? 0 : Math.abs(pct) >= 100 ? 1 : 2;
  return `${sign}${pct.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}%`;
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
function readinessColor(status: string): string {
  if (status === "READY" || status === "TRADE_250" || status === "TRADE_1000") return "var(--green)";
  if (status === "RESEARCH_ONLY") return "var(--orange)";
  if (status === "NOT_READY") return "var(--red)";
  return "var(--label-tertiary)";
}

type HoldHorizonChartRow = {
  horizonMs: number;
  pnlUsd: number;
  returnPct: number;
  annualizedReturnPct: number | null;
  avgRatioMoveBps: number | null;
  closedTrades: number;
  avgHoldSeconds: number;
};

function HoldHorizonLineChart({ rows }: { rows: HoldHorizonChartRow[] }) {
  const points = rows
    .filter((row) => row.annualizedReturnPct != null)
    .map((row) => ({ ...row, annualizedReturnPct: row.annualizedReturnPct! }));
  if (points.length === 0) {
    return (
      <div
        className="hig-footnote"
        style={{
          minHeight: 220,
          display: "grid",
          placeItems: "center",
          color: "var(--label-secondary)",
          borderTop: "1px solid var(--separator)",
          borderBottom: "1px solid var(--separator)",
          marginTop: "0.75rem",
        }}
      >
        No closed trades with measurable hold time yet.
      </div>
    );
  }

  const width = 720;
  const height = 230;
  const left = 54;
  const right = 18;
  const top = 22;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxAbsApr = Math.max(
    0.01,
    ...points.map((row) => Math.abs(row.annualizedReturnPct)),
  );
  const yMax = maxAbsApr;
  const yMin = -maxAbsApr;
  const xFor = (index: number) =>
    left + (points.length === 1 ? plotWidth / 2 : (plotWidth * index) / (points.length - 1));
  const yFor = (value: number) =>
    top + ((yMax - value) / (yMax - yMin)) * plotHeight;
  const line = points
    .map((row, index) => `${xFor(index).toFixed(1)},${yFor(row.annualizedReturnPct).toFixed(1)}`)
    .join(" ");
  const zeroY = yFor(0);

  return (
    <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
      <svg
        role="img"
        aria-label="Holding horizon annualized return line chart"
        viewBox={`0 0 ${width} ${height}`}
        style={{
          display: "block",
          minWidth: 640,
          width: "100%",
          height: "auto",
          borderTop: "1px solid var(--separator)",
          borderBottom: "1px solid var(--separator)",
        }}
      >
        <title>Annualized return estimate by holding horizon</title>
        <line x1={left} x2={width - right} y1={zeroY} y2={zeroY} stroke="var(--separator)" />
        <line x1={left} x2={left} y1={top} y2={height - bottom} stroke="var(--separator)" />
        <text x={0} y={top + 4} className="hig-caption-1" fill="var(--label-tertiary)">
          {fmtApr(yMax)}
        </text>
        <text x={0} y={zeroY + 4} className="hig-caption-1" fill="var(--label-tertiary)">
          0%
        </text>
        <text x={0} y={height - bottom + 4} className="hig-caption-1" fill="var(--label-tertiary)">
          {fmtApr(yMin)}
        </text>
        <polyline
          points={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((row, index) => {
          const x = xFor(index);
          const y = yFor(row.annualizedReturnPct);
          const positive = row.annualizedReturnPct >= 0;
          return (
            <g key={row.horizonMs}>
              <circle
                cx={x}
                cy={y}
                r={4.5}
                fill={positive ? "var(--green)" : "var(--red)"}
                stroke="var(--bg-system)"
                strokeWidth={2}
              />
              <text
                x={x}
                y={height - 18}
                textAnchor="middle"
                className="hig-caption-1"
                fill="var(--label-tertiary)"
              >
                {fmtDuration(row.horizonMs)}
              </text>
              <text
                x={x}
                y={Math.max(12, y - 10)}
                textAnchor="middle"
                className="hig-caption-1"
                fill={positive ? "var(--green)" : "var(--red)"}
              >
                {fmtApr(row.annualizedReturnPct)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
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
    pairReadiness,
    twoSizeBacktest,
    holdHorizonReplay,
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
  const holdHorizonRows = holdHorizonReplay ?? [];

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
                <p className="hig-headline" style={{ margin: 0 }}>Hold horizon replay</p>
                <p className="hig-caption-1" style={{ color: "var(--label-tertiary)", margin: "0.25rem 0 0" }}>
                  Profitability and annualized return from actual hold duration.
                </p>
              </div>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                live rows only
              </span>
            </div>
            <HoldHorizonLineChart rows={holdHorizonRows} />
            <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1040 }}>
                <thead>
                  <tr className="hig-caption-1" style={{ color: "var(--label-tertiary)", textAlign: "left" }}>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Horizon</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>PnL</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Return</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>APR est.</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Ratio move</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Deployed</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Trades</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Win rate</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Timeouts</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Open</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Avg hold</th>
                  </tr>
                </thead>
                <tbody>
                  {holdHorizonRows.map((row) => (
                    <tr key={row.horizonMs} style={{ borderTop: "1px solid var(--separator)" }}>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtDuration(row.horizonMs)}
                      </td>
                      <td
                        className="hig-footnote bt-num"
                        style={{
                          padding: "0.65rem 0.35rem",
                          color: row.pnlUsd > 0 ? "var(--green)" : row.pnlUsd < 0 ? "var(--red)" : "var(--label-primary)",
                        }}
                      >
                        {fmtUsd(row.pnlUsd)}
                      </td>
                      <td
                        className="hig-footnote bt-num"
                        style={{
                          padding: "0.65rem 0.35rem",
                          color: row.returnPct > 0 ? "var(--green)" : row.returnPct < 0 ? "var(--red)" : "var(--label-primary)",
                        }}
                      >
                        {fmtReturnPct(row.returnPct)}
                      </td>
                      <td
                        className="hig-footnote bt-num"
                        style={{
                          padding: "0.65rem 0.35rem",
                          color: (row.annualizedReturnPct ?? 0) > 0 ? "var(--green)" : (row.annualizedReturnPct ?? 0) < 0 ? "var(--red)" : "var(--label-primary)",
                        }}
                      >
                        {fmtApr(row.annualizedReturnPct)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtBps(row.avgRatioMoveBps)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtUsd(row.deployedUsd)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.closedTrades.toLocaleString()}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtPct(row.winRate)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.timedOutTrades.toLocaleString()}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.openPositions.toLocaleString()}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.avgHoldSeconds.toFixed(0)}s
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
                <p className="hig-headline" style={{ margin: 0 }}>Pair readiness</p>
                <p className="hig-caption-1" style={{ color: "var(--label-tertiary)", margin: "0.25rem 0 0" }}>
                  Side and size tradability checks over the 24h observation set.
                </p>
              </div>
              <span className="hig-caption-1" style={{ color: readinessColor(pairReadiness.status), whiteSpace: "nowrap" }}>
                {pairReadiness.status}
              </span>
            </div>
            <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 940 }}>
                <thead>
                  <tr className="hig-caption-1" style={{ color: "var(--label-tertiary)", textAlign: "left" }}>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Side</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Size</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Status</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Success</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Live samples</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Quote p95</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Basis p95</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Routers</th>
                    <th style={{ padding: "0.5rem 0.35rem" }}>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {pairReadiness.rows.map((row) => (
                    <tr key={`${row.side}-${row.sizeUsd}`} style={{ borderTop: "1px solid var(--separator)" }}>
                      <td className="hig-footnote" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.side === "buy_tokenized" ? "Buy tokenized" : "Sell tokenized"}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        ${row.sizeUsd.toLocaleString()}
                      </td>
                      <td className="hig-caption-1" style={{ padding: "0.65rem 0.35rem", color: readinessColor(row.status), whiteSpace: "nowrap" }}>
                        {row.status}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtPct(row.quoteSuccessRate)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {row.liveEligibleCount.toLocaleString()} / {row.sampleCount.toLocaleString()}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtMs(row.quoteLatencyMs.p95)}
                      </td>
                      <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                        {fmtMs(row.basisAgeMs.p95)}
                      </td>
                      <td className="hig-footnote" style={{ padding: "0.65rem 0.35rem", color: "var(--label-secondary)" }}>
                        {row.routerDistribution.slice(0, 2).map((r) => `${r.router} ${fmtPct(r.pct)}`).join(" · ") || "—"}
                      </td>
                      <td className="hig-caption-1" style={{ padding: "0.65rem 0.35rem", color: "var(--label-tertiary)" }}>
                        {row.reasonCodes.slice(0, 3).join(", ") || "—"}
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
                <p className="hig-headline" style={{ margin: 0 }}>$250 vs $1000 replay</p>
                <p className="hig-caption-1" style={{ color: "var(--label-tertiary)", margin: "0.25rem 0 0" }}>
                  Quality-gated spot-only replay; non-live rows stay diagnostic.
                </p>
              </div>
              <span className="hig-caption-1" style={{ color: readinessColor(twoSizeBacktest.recommendedAction), whiteSpace: "nowrap" }}>
                {twoSizeBacktest.recommendedAction}
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "0.75rem",
                marginTop: "0.75rem",
              }}
            >
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Edge 250</div>
                <div className="hig-headline bt-num">{fmtBps(twoSizeBacktest.edge250Bps)}</div>
              </div>
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Edge 1000</div>
                <div className="hig-headline bt-num">{fmtBps(twoSizeBacktest.edge1000Bps)}</div>
              </div>
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>Next 750</div>
                <div className="hig-headline bt-num">{fmtBps(twoSizeBacktest.edgeNext750Bps)}</div>
              </div>
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>PnL 250</div>
                <div className="hig-headline bt-num">{fmtUsd(twoSizeBacktest.pnl250)}</div>
              </div>
              <div>
                <div className="hig-footnote" style={{ color: "var(--label-secondary)" }}>PnL 1000</div>
                <div className="hig-headline bt-num">{fmtUsd(twoSizeBacktest.pnl1000)}</div>
              </div>
            </div>
            {twoSizeBacktest.skippedSignalReasons.length === 0 ? null : (
              <div style={{ overflowX: "auto", marginTop: "0.75rem" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 420 }}>
                  <thead>
                    <tr className="hig-caption-1" style={{ color: "var(--label-tertiary)", textAlign: "left" }}>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Skipped reason</th>
                      <th style={{ padding: "0.5rem 0.35rem" }}>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {twoSizeBacktest.skippedSignalReasons.map((row) => (
                      <tr key={row.reason} style={{ borderTop: "1px solid var(--separator)" }}>
                        <td className="hig-caption-1" style={{ padding: "0.65rem 0.35rem", color: "var(--label-secondary)" }}>
                          {row.reason}
                        </td>
                        <td className="hig-footnote bt-num" style={{ padding: "0.65rem 0.35rem" }}>
                          {row.count.toLocaleString()}
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
