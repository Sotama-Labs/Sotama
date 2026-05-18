import type { PairReadinessMatrix } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { fmtMs, fmtNumber, fmtPct } from "@/lib/format";

type Row = PairReadinessMatrix["rows"][number];

const STATUS_COLOR: Record<Row["status"], string> = {
  READY: "var(--green)",
  RESEARCH_ONLY: "var(--orange)",
  NOT_READY: "var(--red)",
};

export function PairReadinessPanel({ matrix }: { matrix: PairReadinessMatrix }) {
  return (
    <Section
      title="Feasibility checklist"
      subtitle="Tradability per side and size. Failed checks summarize the gap in plain language."
      action={
        <span
          className="hig-caption-1"
          style={{
            color: STATUS_COLOR[matrix.status],
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontSize: "0.6875rem",
          }}
        >
          {matrix.status}
        </span>
      }
    >
      <DataTable<Row>
        rowKey={(r) => `${r.side}-${r.sizeUsd}`}
        columns={columns()}
        rows={matrix.rows}
      />
    </Section>
  );
}

function columns(): Column<Row>[] {
  return [
    {
      key: "side",
      header: "Side",
      render: (r) => (r.side === "buy_tokenized" ? "Buy tokenized" : "Sell tokenized"),
    },
    {
      key: "size",
      header: "Size",
      numeric: true,
      render: (r) => `$${r.sizeUsd.toLocaleString()}`,
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <span style={{ color: STATUS_COLOR[r.status], fontWeight: 600 }}>{r.status}</span>
      ),
    },
    {
      key: "success",
      header: "Quote success",
      numeric: true,
      render: (r) => fmtPct(r.quoteSuccessRate ?? 0),
    },
    {
      key: "live",
      header: "Live samples",
      numeric: true,
      render: (r) => `${fmtNumber(r.liveEligibleCount)} / ${fmtNumber(r.sampleCount)}`,
    },
    {
      key: "latency",
      header: "Quote p95",
      numeric: true,
      render: (r) => fmtMs(r.quoteLatencyMs.p95),
    },
    {
      key: "basis",
      header: "Basis age p95",
      numeric: true,
      render: (r) => fmtMs(r.basisAgeMs.p95),
    },
    {
      key: "router",
      header: "Top router",
      render: (r) =>
        r.routerDistribution[0]
          ? `${r.routerDistribution[0].router} (${fmtPct(r.routerDistribution[0].pct)})`
          : "—",
    },
    {
      key: "reasons",
      header: "Reasons",
      render: (r) => (
        <span style={{ color: "var(--label-tertiary)" }}>
          {r.reasonCodes.slice(0, 3).join(", ") || "—"}
        </span>
      ),
    },
  ];
}
