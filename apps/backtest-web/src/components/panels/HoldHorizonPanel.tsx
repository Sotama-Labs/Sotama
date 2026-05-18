import type { HoldHorizonReplayRow } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import {
  fmtApr,
  fmtBps,
  fmtDuration,
  fmtNumber,
  fmtPct,
  fmtReturnPct,
  fmtUsd,
  signedColor,
} from "@/lib/format";

const APR_MIN_AVG_HOLD_SECONDS = 60;
const APR_MIN_CLOSED_TRADES = 30;

export function HoldHorizonPanel({ rows }: { rows: readonly HoldHorizonReplayRow[] }) {
  return (
    <Section
      title="Hold-horizon replay"
      subtitle="Max-hold spot-only paper replay across multiple horizons; rows stay pending until the observation window covers them."
    >
      <HorizonChart rows={rows} />
      <div style={{ marginTop: "0.875rem" }}>
        <DataTable<HoldHorizonReplayRow>
          rowKey={(r) => `${r.horizonMs}`}
          columns={tableColumns()}
          rows={rows}
        />
      </div>
    </Section>
  );
}

// ─── Chart ──────────────────────────────────────────────────────────

function HorizonChart({ rows }: { rows: readonly HoldHorizonReplayRow[] }) {
  const points = rows
    .filter(
      (row) =>
        row.horizonCovered &&
        row.annualizedReturnPct != null &&
        aprSuppressionReason(row) == null,
    )
    .map((row) => ({ ...row, annualizedReturnPct: row.annualizedReturnPct! }));

  if (points.length === 0) {
    return (
      <div
        className="hig-footnote"
        style={{
          minHeight: 180,
          display: "grid",
          placeItems: "center",
          color: "var(--label-secondary)",
          background: "var(--fill-4)",
          borderRadius: "var(--radius-control-m)",
          padding: "1rem",
          textAlign: "center",
        }}
      >
        Horizon rows stay pending until the window covers them; APR also needs ≥60s avg hold and ≥30 exits.
      </div>
    );
  }

  const width = 720;
  const height = 220;
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
    <div style={{ overflowX: "auto" }}>
      <svg
        role="img"
        aria-label="Annualized return by holding horizon"
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
                stroke="var(--bg-grouped-2)"
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

function horizonPendingReason(row: HoldHorizonReplayRow): string | null {
  if (row.horizonCovered) return null;
  return `pending ${fmtDuration(row.sampleWindowMs)} / ${fmtDuration(row.horizonMs)}`;
}

function aprSuppressionReason(row: HoldHorizonReplayRow): string | null {
  const pending = horizonPendingReason(row);
  if (pending) return pending;
  if (row.annualizedReturnPct == null || row.closedTrades === 0) return "no exits";
  if (row.avgHoldSeconds < APR_MIN_AVG_HOLD_SECONDS) return "hold <60s";
  if (row.closedTrades < APR_MIN_CLOSED_TRADES) return `n<${APR_MIN_CLOSED_TRADES}`;
  return null;
}

// ─── Table ──────────────────────────────────────────────────────────

function tableColumns(): Column<HoldHorizonReplayRow>[] {
  return [
    {
      key: "horizon",
      header: "Horizon",
      render: (r) => fmtDuration(r.horizonMs),
    },
    {
      key: "pnl",
      header: "PnL",
      numeric: true,
      render: (r) =>
        horizonPendingReason(r) ? horizonPendingReason(r)! : fmtUsd(r.pnlUsd),
      color: (r) =>
        horizonPendingReason(r) ? "var(--label-tertiary)" : signedColor(r.pnlUsd),
    },
    {
      key: "return",
      header: "Return",
      numeric: true,
      render: (r) =>
        horizonPendingReason(r) ? "pending" : fmtReturnPct(r.returnPct),
      color: (r) =>
        horizonPendingReason(r) ? "var(--label-tertiary)" : signedColor(r.returnPct),
    },
    {
      key: "apr",
      header: "APR est.",
      numeric: true,
      render: (r) => aprSuppressionReason(r) ?? fmtApr(r.annualizedReturnPct),
      color: (r) =>
        aprSuppressionReason(r)
          ? "var(--label-tertiary)"
          : signedColor(r.annualizedReturnPct),
    },
    {
      key: "trades",
      header: "Trades",
      numeric: true,
      render: (r) =>
        horizonPendingReason(r) ? "pending" : fmtNumber(r.closedTrades),
    },
    {
      key: "win",
      header: "Win rate",
      numeric: true,
      render: (r) => (horizonPendingReason(r) ? "pending" : fmtPct(r.winRate)),
    },
    {
      key: "timeouts",
      header: "Timeouts",
      numeric: true,
      render: (r) =>
        horizonPendingReason(r) ? "pending" : fmtNumber(r.timedOutTrades),
    },
    {
      key: "open",
      header: "Open",
      numeric: true,
      render: (r) =>
        horizonPendingReason(r) ? "pending" : fmtNumber(r.openPositions),
    },
    {
      key: "ratio",
      header: "Ratio move",
      numeric: true,
      render: (r) =>
        horizonPendingReason(r) ? "pending" : fmtBps(r.avgRatioMoveBps),
    },
    {
      key: "hold",
      header: "Avg hold",
      numeric: true,
      render: (r) =>
        horizonPendingReason(r) ? "pending" : `${r.avgHoldSeconds.toFixed(0)}s`,
    },
  ];
}
