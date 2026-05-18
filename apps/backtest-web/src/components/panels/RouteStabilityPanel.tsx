import type { RouteStabilitySummary } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { StatGrid } from "@/components/ui/StatGrid";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { fmtBps, fmtMs, fmtNumber, fmtPct, fmtSeconds } from "@/lib/format";

type Row = RouteStabilitySummary["perSideSize"][number];

export function RouteStabilityPanel({ summary }: { summary: RouteStabilitySummary }) {
  const topRouter = summary.topRouter;
  return (
    <Section
      title="Route stability"
      subtitle="Jupiter router behavior over the 24h window. Stable routes survive entry/exit; flickering routes cancel paper edges before they execute."
      action={
        <span
          className="hig-caption-1"
          style={{
            color: summary.routeStable ? "var(--green)" : "var(--orange)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontSize: "0.6875rem",
          }}
        >
          {summary.routeStable ? "Stable" : "Unstable"}
        </span>
      }
    >
      <StatGrid
        tiles={[
          {
            label: "Top router",
            value: topRouter ? topRouter.router : "—",
            hint: topRouter ? `${fmtPct(topRouter.pct)} share` : "no router observed",
          },
          {
            label: "Switches/hr",
            value: summary.routerChangesPerHour == null ? "—" : summary.routerChangesPerHour.toFixed(1),
          },
          {
            label: "Success rate",
            value: fmtPct(summary.overallSuccessRate ?? 0),
            hint: `${fmtNumber(summary.totalOkCount)}/${fmtNumber(summary.totalSampleCount)} ok`,
          },
        ]}
      />
      <div style={{ marginTop: "0.875rem" }}>
        <DataTable<Row>
          rowKey={(r) => `${r.side}-${r.sizeUsd}`}
          columns={columns()}
          rows={summary.perSideSize}
        />
      </div>
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
      key: "samples",
      header: "Samples",
      numeric: true,
      render: (r) => `${fmtNumber(r.okCount)} / ${fmtNumber(r.sampleCount)}`,
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
      key: "changes",
      header: "Switches/hr",
      numeric: true,
      render: (r) => (r.routerChangesPerHour == null ? "—" : r.routerChangesPerHour.toFixed(1)),
    },
    {
      key: "latency",
      header: "Latency p95",
      numeric: true,
      render: (r) => fmtMs(r.requestLatencyMs.p95),
    },
    {
      key: "impact",
      header: "Impact p95",
      numeric: true,
      render: (r) => fmtBps(r.priceImpactBps.p95, { signed: false }),
    },
    {
      key: "expiry",
      header: "Expiry p50",
      numeric: true,
      render: (r) => fmtSeconds(r.quoteExpirySeconds.p50),
    },
  ];
}
