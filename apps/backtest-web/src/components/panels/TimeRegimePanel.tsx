import type { TimeRegimeSummaryDto } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { fmtBps, fmtMs, fmtNumber, fmtPct, signedColor } from "@/lib/format";

export function TimeRegimePanel({ rows }: { rows: readonly TimeRegimeSummaryDto[] }) {
  return (
    <Section
      title="Regime breakdown"
      subtitle="24h basis observations grouped by underlying-reference session and bot-side regime."
      action={
        <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
          {rows.reduce((sum, row) => sum + row.observationCount, 0).toLocaleString()} rows
        </span>
      }
    >
      <DataTable<TimeRegimeSummaryDto>
        rowKey={(r) => r.timeRegime}
        columns={columns()}
        rows={rows}
      />
    </Section>
  );
}

function columns(): Column<TimeRegimeSummaryDto>[] {
  return [
    { key: "regime", header: "Regime", render: (r) => r.timeRegime },
    {
      key: "obs",
      header: "Obs",
      numeric: true,
      render: (r) => fmtNumber(r.observationCount),
    },
    {
      key: "live",
      header: "Live",
      numeric: true,
      render: (r) => fmtPct(r.livePct),
    },
    {
      key: "buy",
      header: "Buy / sell",
      numeric: true,
      render: (r) => `${fmtNumber(r.buyCount)} / ${fmtNumber(r.sellCount)}`,
    },
    {
      key: "gross",
      header: "Avg gross",
      numeric: true,
      render: (r) => fmtBps(r.avgGrossBps),
    },
    {
      key: "net",
      header: "Avg net",
      numeric: true,
      render: (r) => fmtBps(r.avgNetBps),
      color: (r) => signedColor(r.avgNetBps),
    },
    {
      key: "max",
      header: "Max net",
      numeric: true,
      render: (r) => fmtBps(r.maxNetBps),
    },
    {
      key: "min",
      header: "Min net",
      numeric: true,
      render: (r) => fmtBps(r.minNetBps),
    },
    {
      key: "quote",
      header: "Quote",
      numeric: true,
      render: (r) => fmtMs(r.avgQuoteRequestMs),
    },
    {
      key: "pyth",
      header: "Pyth lag",
      numeric: true,
      render: (r) => fmtMs(r.avgPythFreshnessLagMs),
    },
    {
      key: "basis",
      header: "Basis age",
      numeric: true,
      render: (r) => fmtMs(r.avgBasisAgeMs),
    },
  ];
}
