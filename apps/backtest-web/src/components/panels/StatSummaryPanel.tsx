import type { PairStatSummary } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { StatGrid } from "@/components/ui/StatGrid";
import { Sparkline } from "@/components/ui/Sparkline";
import {
  fmtBps,
  fmtDuration,
  fmtNumber,
  fmtRatio,
  fmtSeconds,
  signedColor,
} from "@/lib/format";
import { DataTable, type Column } from "@/components/ui/DataTable";

export function StatSummaryPanel({ summaries }: { summaries: readonly PairStatSummary[] }) {
  const primary = pickPrimary(summaries);
  if (!primary || primary.liveSampleCount === 0) {
    return (
      <Section
        title="Statistical evidence"
        subtitle="Rolling fair ratio, deviation, z-score, and opportunity persistence."
      >
        <p className="hig-footnote" style={{ color: "var(--label-secondary)", margin: 0 }}>
          Not enough live-eligible samples for a statistical summary yet.
        </p>
      </Section>
    );
  }

  return (
    <Section
      title="Statistical evidence"
      subtitle={`Window: ${fmtDuration(primary.windowMs)} · primary side: ${
        primary.side === "buy_tokenized" ? "Buy tokenized" : "Sell tokenized"
      } · size: $${primary.sizeUsd.toLocaleString()}`}
    >
      <StatGrid
        tiles={[
          {
            label: "Fair ratio",
            value: fmtRatio(primary.fairRatio),
            hint: "rolling median",
          },
          {
            label: "Current ratio",
            value: fmtRatio(primary.currentRatio),
            hint: `dev ${fmtBps(primary.currentDeviationBps)}`,
            color: signedColor(primary.currentDeviationBps),
          },
          {
            label: "Robust z-score",
            value: primary.robustZScore == null ? "—" : primary.robustZScore.toFixed(2),
            hint: `std z ${primary.currentZScore == null ? "—" : primary.currentZScore.toFixed(2)}`,
          },
          {
            label: "Basis volatility",
            value: fmtBps(primary.basisVolBps, { signed: false }),
            hint: "stddev of deviation",
          },
          {
            label: "Opportunities",
            value: fmtNumber(primary.opportunityCount),
            hint: `avg ${fmtSeconds(primary.avgOpportunityDurationSeconds)}`,
          },
          {
            label: "Half-life",
            value: primary.halfLifeSeconds == null ? "—" : fmtSeconds(primary.halfLifeSeconds),
            hint: primary.halfLifeSeconds == null ? "thin sample" : "lagged regression",
          },
        ]}
      />
      <div
        className="bt-stat-evidence-grid"
      >
        <Quantiles primary={primary} />
        <TailDistribution primary={primary} />
      </div>
      {primary.regimeBreakdown.length > 0 ? (
        <div style={{ marginTop: "0.875rem" }}>
          <RegimeBreakdown rows={primary.regimeBreakdown} />
        </div>
      ) : null}
    </Section>
  );
}

function pickPrimary(summaries: readonly PairStatSummary[]): PairStatSummary | null {
  const buys = summaries.filter((s) => s.side === "buy_tokenized");
  const ordered = [...(buys.length > 0 ? buys : summaries)].sort(
    (a, b) => b.liveSampleCount - a.liveSampleCount,
  );
  return ordered[0] ?? null;
}

function Quantiles({ primary }: { primary: PairStatSummary }) {
  const rows: Array<{ label: string; value: number | null }> = [
    { label: "p01", value: primary.deviationQuantilesBps.p01 },
    { label: "p05", value: primary.deviationQuantilesBps.p05 },
    { label: "p10", value: primary.deviationQuantilesBps.p10 },
    { label: "p50", value: primary.deviationQuantilesBps.p50 },
    { label: "p90", value: primary.deviationQuantilesBps.p90 },
    { label: "p95", value: primary.deviationQuantilesBps.p95 },
    { label: "p99", value: primary.deviationQuantilesBps.p99 },
  ];
  return (
    <div
      style={{
        padding: "0.625rem 0.75rem",
        background: "var(--fill-4)",
        borderRadius: "var(--radius-control-m)",
      }}
    >
      <p
        className="hig-caption-1"
        style={{
          margin: "0 0 0.375rem",
          color: "var(--label-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontSize: "0.6875rem",
        }}
      >
        Deviation quantiles (bps)
      </p>
      <Sparkline
        values={rows.map((r) => r.value)}
        width={220}
        height={48}
        stroke="var(--accent)"
        zeroLine
        ariaLabel="Deviation quantiles"
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: "0.25rem",
          marginTop: "0.4375rem",
        }}
      >
        {rows.map((r) => (
          <div key={r.label} style={{ textAlign: "center" }}>
            <div
              className="hig-caption-1"
              style={{ color: "var(--label-tertiary)", fontSize: "0.625rem" }}
            >
              {r.label}
            </div>
            <div className="hig-caption-1 bt-num" style={{ color: signedColor(r.value) }}>
              {r.value == null ? "—" : r.value.toFixed(0)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TailDistribution({ primary }: { primary: PairStatSummary }) {
  return (
    <div
      style={{
        padding: "0.625rem 0.75rem",
        background: "var(--fill-4)",
        borderRadius: "var(--radius-control-m)",
        display: "flex",
        flexDirection: "column",
        gap: "0.4375rem",
      }}
    >
      <p
        className="hig-caption-1"
        style={{
          margin: 0,
          color: "var(--label-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontSize: "0.6875rem",
        }}
      >
        Tail asymmetry
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.4375rem" }}>
        <TailRow
          label="Onchain cheap"
          color="var(--green)"
          count={primary.cheapTailCount}
          total={primary.liveSampleCount}
        />
        <TailRow
          label="Onchain rich"
          color="var(--accent)"
          count={primary.richTailCount}
          total={primary.liveSampleCount}
        />
      </div>
      <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
        Skew (rich − cheap) {fmtBps(primary.skewBps)}
      </span>
    </div>
  );
}

function TailRow({
  label,
  color,
  count,
  total,
}: {
  label: string;
  color: string;
  count: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : count / total;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div className="hig-caption-1" style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "var(--label-secondary)" }}>{label}</span>
        <span className="bt-num" style={{ color }}>
          {count.toLocaleString()} · {(pct * 100).toFixed(1)}%
        </span>
      </div>
      <div
        style={{
          height: 4,
          background: "var(--fill-3)",
          borderRadius: 2,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: `${(pct * 100).toFixed(1)}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );
}

function RegimeBreakdown({ rows }: { rows: PairStatSummary["regimeBreakdown"] }) {
  const columns: Column<PairStatSummary["regimeBreakdown"][number]>[] = [
    { key: "regime", header: "Regime", render: (r) => r.regime },
    {
      key: "samples",
      header: "Samples",
      numeric: true,
      render: (r) => fmtNumber(r.liveSampleCount),
    },
    {
      key: "fair",
      header: "Fair ratio",
      numeric: true,
      render: (r) => fmtRatio(r.fairRatio),
    },
    {
      key: "median",
      header: "Median dev (bps)",
      numeric: true,
      render: (r) => (r.medianDeviationBps == null ? "—" : r.medianDeviationBps.toFixed(1)),
      color: (r) => signedColor(r.medianDeviationBps),
    },
    {
      key: "p05",
      header: "p05",
      numeric: true,
      render: (r) => (r.p05DeviationBps == null ? "—" : r.p05DeviationBps.toFixed(0)),
    },
    {
      key: "p95",
      header: "p95",
      numeric: true,
      render: (r) => (r.p95DeviationBps == null ? "—" : r.p95DeviationBps.toFixed(0)),
    },
  ];
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r.regime} />;
}
