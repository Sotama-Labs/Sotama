import type {
  BestSideDto,
  CurrentOpportunityDto,
} from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { StatGrid } from "@/components/ui/StatGrid";
import { BasisChip } from "@/components/chips/BasisChip";
import { QualityChip } from "@/components/chips/QualityChip";
import {
  fmtBps,
  fmtDuration,
  fmtMs,
  fmtRatio,
  fmtUsd,
} from "@/lib/format";

export function OpportunityPanel({
  pairLabel,
  opportunity,
  diagnosticBuy,
  diagnosticSell,
}: {
  pairLabel: string;
  opportunity: CurrentOpportunityDto;
  diagnosticBuy: BestSideDto | null;
  diagnosticSell: BestSideDto | null;
}) {
  const hasLive = opportunity.hasLiveOpportunity;
  return (
    <Section
      title="Current opportunity"
      subtitle={`Live-eligible quotes only. ${pairLabel} basis (onchain price / underlying reference).`}
      action={
        <span
          className="hig-caption-1"
          style={{
            color: hasLive ? "var(--green)" : "var(--label-tertiary)",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            fontSize: "0.6875rem",
          }}
        >
          {hasLive ? "Live" : "No live row"}
        </span>
      }
    >
      {hasLive ? (
        <StatGrid
          tiles={[
            ...sideTiles("Best buy", opportunity.bestBuy, "buy"),
            ...sideTiles("Best sell", opportunity.bestSell, "sell"),
            ...spreadTiles(opportunity),
            {
              label: "Quote age",
              value: fmtDuration(opportunity.quoteAgeMs),
              hint: "freshest live row",
            },
          ]}
        />
      ) : (
        <div
          style={{
            padding: "0.875rem 1rem",
            background: "var(--fill-4)",
            borderRadius: "var(--radius-control-m)",
            color: "var(--label-secondary)",
            display: "flex",
            flexDirection: "column",
            gap: "0.625rem",
          }}
        >
          <p className="hig-subheadline" style={{ margin: 0, color: "var(--label-primary)" }}>
            {opportunity.notExecutableReason ?? "No live-eligible quote in the latest window."}
          </p>
          <DiagnosticHint diagnosticBuy={diagnosticBuy} diagnosticSell={diagnosticSell} />
        </div>
      )}
    </Section>
  );
}

function sideTiles(
  label: string,
  side: BestSideDto | null,
  kind: "buy" | "sell",
) {
  if (!side) {
    return [
      {
        label,
        value: "—",
        hint: "no live row",
        color: "var(--label-tertiary)",
      },
    ];
  }
  const color =
    kind === "buy"
      ? side.ratio < 1
        ? "var(--green)"
        : "var(--label-primary)"
      : side.ratio > 1
        ? "var(--green)"
        : "var(--label-primary)";
  return [
    {
      label,
      value: fmtRatio(side.ratio),
      color,
      hint: (
        <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
          <BasisChip bps={side.displayBasisBps} interpretation={side.displayBasisInterpretation} />
          <span>
            {fmtUsd(side.tokenPriceUsd)} · ${side.sizeUsd.toLocaleString()} · net {fmtBps(side.netBps)}
          </span>
        </span>
      ),
    },
  ];
}

function spreadTiles(opportunity: CurrentOpportunityDto) {
  const spread = opportunity.roundTripSpread;
  if (!spread) {
    return [
      {
        label: "Round-trip spread",
        value: "—",
        hint: "no synchronized buy/sell",
        color: "var(--label-tertiary)",
      },
    ];
  }
  return [
    {
      label: "Round-trip spread",
      value: fmtBps(spread.spreadBps, { signed: spread.spreadBps < 0 }),
      hint: `$${spread.sizeUsd.toLocaleString()} · sync gap ${fmtMs(spread.maxAgeGapMs)}`,
      color: spread.spreadBps < 0 ? "var(--green)" : "var(--label-primary)",
    },
  ];
}

function DiagnosticHint({
  diagnosticBuy,
  diagnosticSell,
}: {
  diagnosticBuy: BestSideDto | null;
  diagnosticSell: BestSideDto | null;
}) {
  const examples = [diagnosticBuy, diagnosticSell].filter(
    (row): row is BestSideDto => row != null,
  );
  if (examples.length === 0) {
    return (
      <p className="hig-caption-1" style={{ margin: 0, color: "var(--label-tertiary)" }}>
        No diagnostic rows in the latest window yet.
      </p>
    );
  }
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      {examples.map((row) => (
        <span
          key={`${row.side}-${row.sizeUsd}`}
          className="hig-caption-1"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--label-secondary)" }}
        >
          <span>{row.side === "buy_tokenized" ? "Diag buy" : "Diag sell"}</span>
          <span className="bt-num" style={{ color: "var(--label-primary)" }}>
            {fmtRatio(row.ratio)}
          </span>
          {row.qualityStatus ? (
            <QualityChip status={row.qualityStatus} reason={row.qualityReason} />
          ) : null}
        </span>
      ))}
    </div>
  );
}
