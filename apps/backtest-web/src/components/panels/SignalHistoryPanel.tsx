import type { ProfitabilitySummary, SignalHistoryDto } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { StatGrid } from "@/components/ui/StatGrid";
import { DataTable, type Column } from "@/components/ui/DataTable";
import {
  fmtBps,
  fmtIsoTime,
  fmtNumber,
  fmtPct,
  fmtSeconds,
  fmtUsd,
  signedColor,
} from "@/lib/format";

export function SignalHistoryPanel({
  history,
  profitability,
}: {
  history: readonly SignalHistoryDto[];
  profitability: ProfitabilitySummary;
}) {
  return (
    <Section
      title="Paper signal history"
      subtitle="Spot-inventory only: open via buy_tokenized, close via sell_tokenized. No synthetic shorts."
      action={
        <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
          {history.length} recent
        </span>
      }
    >
      <StatGrid
        minTileWidth={140}
        tiles={[
          {
            label: "Paper PnL (7d)",
            value: fmtUsd(profitability.pnlUsd7d),
            color: signedColor(profitability.pnlUsd7d),
          },
          {
            label: "Win rate",
            value: fmtPct(profitability.winRate),
            hint: `${fmtNumber(profitability.signalCount)} signals`,
          },
          {
            label: "Max drawdown",
            value: fmtUsd(profitability.maxDrawdownUsd),
            color: "var(--red)",
          },
          {
            label: "Avg hold",
            value: fmtSeconds(profitability.avgHoldSeconds),
            hint: `avg edge ${fmtBps(profitability.avgEdgeBps)}`,
          },
        ]}
      />
      <div style={{ marginTop: "0.875rem" }}>
        <DataTable<SignalHistoryDto>
          rowKey={(r) => r.id}
          columns={columns()}
          rows={history}
        />
      </div>
    </Section>
  );
}

function columns(): Column<SignalHistoryDto>[] {
  return [
    { key: "exit", header: "Exit", render: (r) => fmtIsoTime(r.exitAt) },
    {
      key: "size",
      header: "Size",
      numeric: true,
      render: (r) => `$${r.sizeUsd.toLocaleString()}`,
    },
    {
      key: "entry",
      header: "Entry edge",
      numeric: true,
      render: (r) => fmtBps(r.entryEdgeBps),
    },
    {
      key: "exitEdge",
      header: "Exit edge",
      numeric: true,
      render: (r) => fmtBps(r.exitEdgeBps),
    },
    {
      key: "pnl",
      header: "PnL",
      numeric: true,
      render: (r) => fmtUsd(r.pnlUsd),
      color: (r) => signedColor(r.pnlUsd),
    },
    {
      key: "reason",
      header: "Reason",
      render: (r) => r.exitReason ?? r.outcome,
    },
  ];
}
