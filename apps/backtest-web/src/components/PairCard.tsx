import Link from "next/link";
import { Card, FreshnessDot, levelForAgeMs } from "@sotama/ui";
import type { PairPanelDto } from "@sotama/market-core";
import { BasisChip } from "@/components/chips/BasisChip";
import { PairClassChip } from "@/components/chips/PairClassChip";
import { ReferenceStatusChip } from "@/components/chips/ReferenceStatusChip";
import { VerdictChip } from "@/components/chips/VerdictChip";
import {
  fmtBps,
  fmtDuration,
  fmtNumber,
  fmtRatio,
} from "@/lib/format";

export function PairCard({ panel }: { panel: PairPanelDto }) {
  const opportunity = panel.currentOpportunity;
  const primary = opportunity.bestBuy ?? opportunity.bestSell ?? panel.bestDiagnosticBuy ?? panel.bestDiagnosticSell;
  const ageMs = opportunity.quoteAgeMs ?? panel.quoteAgeMs;
  const level = levelForAgeMs(ageMs);
  return (
    <Link
      href={`/pairs/${encodeURIComponent(panel.pair.id)}`}
      style={{ textDecoration: "none", color: "inherit" }}
    >
      <Card interactive>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span className="hig-headline" style={{ whiteSpace: "nowrap" }}>
                {panel.displayLabel}
              </span>
              <FreshnessDot ageMs={ageMs} />
            </div>
            <VerdictChip verdict={panel.verdict} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <PairClassChip pairClass={panel.pairClass} />
            <ReferenceStatusChip status={panel.referenceStatus} />
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.5rem",
              marginTop: "0.125rem",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                Best basis
              </span>
              {primary ? (
                <>
                  <span className="hig-title-3 bt-num">
                    {fmtRatio(primary.ratio)}
                  </span>
                  <BasisChip
                    bps={primary.displayBasisBps}
                    interpretation={primary.displayBasisInterpretation}
                  />
                </>
              ) : (
                <span className="hig-callout" style={{ color: "var(--label-tertiary)" }}>
                  —
                </span>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                Net edge / age
              </span>
              <span className="hig-headline bt-num">
                {primary ? fmtBps(primary.netBps) : "—"}
              </span>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {fmtDuration(ageMs)} · {level === "live" ? "live" : level === "warm" ? "lagging" : level === "stale" ? "stale" : "no data"}
              </span>
            </div>
          </div>
          {panel.primaryBlocker ? (
            <p
              className="hig-caption-1"
              style={{
                margin: "0.125rem 0 0",
                color: "var(--label-secondary)",
              }}
            >
              {panel.primaryBlocker}
            </p>
          ) : (
            <p
              className="hig-caption-1"
              style={{
                margin: "0.125rem 0 0",
                color: "var(--label-tertiary)",
              }}
            >
              {fmtNumber(panel.liveSampleCount24h)} live samples · {panel.pair.directions.length} dir
              {panel.pair.directions.length === 1 ? "" : "s"} · {panel.pair.sizesUsd.length} size
              {panel.pair.sizesUsd.length === 1 ? "" : "s"}
            </p>
          )}
        </div>
      </Card>
    </Link>
  );
}
