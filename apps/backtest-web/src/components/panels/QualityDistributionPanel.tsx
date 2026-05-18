import type { QuoteQualityDistributionDto } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { qualityColor, qualityLabel } from "@/components/chips/QualityChip";
import { fmtPct } from "@/lib/format";

export function QualityDistributionPanel({
  rows,
}: {
  rows: readonly QuoteQualityDistributionDto[];
}) {
  const total = rows.reduce((sum, row) => sum + row.observationCount, 0);
  return (
    <Section
      title="Quality distribution"
      subtitle="Why each row is live-eligible — or why it isn't — across the 24h window."
      action={
        <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
          {total.toLocaleString()} rows
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className="hig-footnote" style={{ color: "var(--label-secondary)", margin: 0 }}>
          No quality-gated observations in the current window.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.4375rem" }}>
          {rows.map((row) => (
            <div
              key={row.qualityStatus}
              style={{ display: "flex", flexDirection: "column", gap: 4 }}
            >
              <div
                className="hig-caption-1"
                style={{ display: "flex", justifyContent: "space-between" }}
              >
                <span style={{ color: qualityColor(row.qualityStatus), fontWeight: 600 }}>
                  {qualityLabel(row.qualityStatus)}
                </span>
                <span className="bt-num" style={{ color: "var(--label-secondary)" }}>
                  {row.observationCount.toLocaleString()} · {fmtPct(row.observationPct)}
                </span>
              </div>
              <div
                style={{
                  height: 4,
                  background: "var(--fill-3)",
                  borderRadius: 2,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${(row.observationPct * 100).toFixed(2)}%`,
                    background: qualityColor(row.qualityStatus),
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}
