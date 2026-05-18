import type { PairConfig, QuoteSurfaceRowDto } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { QualityChip } from "@/components/chips/QualityChip";
import { BasisChip } from "@/components/chips/BasisChip";
import { fmtBps, fmtMs, fmtUsd, signedColor } from "@/lib/format";

export function QuoteSurfacePanel({
  pair,
  rows,
}: {
  pair: PairConfig;
  rows: readonly QuoteSurfaceRowDto[];
}) {
  return (
    <Section
      title="Quote surface"
      subtitle="Latest executable quote per side and size, with the same row's quality verdict."
      action={
        <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
          {rows.length} latest rows
        </span>
      }
    >
      <DataTable<QuoteSurfaceRowDto>
        rowKey={(r) => `${r.side}-${r.sizeUsd}`}
        columns={columns(pair)}
        rows={rows}
      />
    </Section>
  );
}

function columns(pair: PairConfig): Column<QuoteSurfaceRowDto>[] {
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
      key: "quality",
      header: "Quality",
      render: (r) => <QualityChip status={r.qualityStatus} reason={r.qualityReason} />,
    },
    {
      key: "token",
      header: "Token price",
      numeric: true,
      render: (r) => fmtUsd(r.tokenPriceUsd),
    },
    {
      key: "basis",
      header: "Display basis",
      numeric: true,
      render: (r) => (
        <BasisChip bps={r.displayBasisBps} interpretation={r.displayBasisInterpretation} label="" />
      ),
    },
    {
      key: "net",
      header: "Net edge",
      numeric: true,
      render: (r) => fmtBps(r.netBps),
      color: (r) =>
        r.netBps >= pair.minNetEdgeBps ? "var(--green)" : signedColor(r.netBps),
    },
    {
      key: "pyth",
      header: "Pyth lag",
      numeric: true,
      render: (r) => fmtMs(r.pythFreshnessLagMs),
    },
    {
      key: "quote",
      header: "Quote latency",
      numeric: true,
      render: (r) => fmtMs(r.quoteRequestMs),
    },
    {
      key: "regime",
      header: "Regime",
      render: (r) => r.timeRegime ?? "—",
    },
  ];
}
