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
  const statusNote = panel.pair.enabled
    ? panel.primaryBlocker
    : "Pair paused; the bot is not scheduling feed or route probes.";
  return (
    <Link
      href={`/pairs/${encodeURIComponent(panel.pair.id)}`}
      className="bt-card-link"
    >
      <Card interactive className="bt-pair-card">
        <div className="bt-pair-card__body">
          <div className="bt-pair-card__top">
            <div className="bt-pair-card__title-row">
              <span className="hig-headline bt-pair-card__title">
                {panel.displayLabel}
              </span>
              <FreshnessDot ageMs={ageMs} />
            </div>
            <VerdictChip verdict={panel.verdict} />
          </div>
          <div className="bt-chip-row">
            <PairClassChip pairClass={panel.pairClass} />
            <ReferenceStatusChip status={panel.referenceStatus} />
            {!panel.pair.enabled ? <span className="hig-caption-1 bt-paused-chip">Paused</span> : null}
          </div>
          <div className="bt-pair-card__metrics">
            <div className="bt-pair-card__metric">
              <span className="hig-caption-1 bt-pair-card__metric-label">
                Basis
              </span>
              {primary ? (
                <>
                  <span className="hig-title-3 bt-num bt-pair-card__metric-value">
                    {fmtRatio(primary.ratio)}
                  </span>
                  <BasisChip
                    bps={primary.displayBasisBps}
                    interpretation={primary.displayBasisInterpretation}
                  />
                </>
              ) : (
                <span className="hig-callout bt-pair-card__empty">
                  —
                </span>
              )}
            </div>
            <div className="bt-pair-card__metric">
              <span className="hig-caption-1 bt-pair-card__metric-label">
                Edge / age
              </span>
              <span className="hig-headline bt-num bt-pair-card__metric-value">
                {primary ? fmtBps(primary.netBps) : "—"}
              </span>
              <span className="hig-caption-1 bt-pair-card__metric-hint">
                {fmtDuration(ageMs)} · {level === "live" ? "live" : level === "warm" ? "lagging" : level === "stale" ? "stale" : "no data"}
              </span>
            </div>
          </div>
          {statusNote ? (
            <p
              className="hig-caption-1 bt-pair-card__note bt-clamp-2"
            >
              {statusNote}
            </p>
          ) : (
            <p
              className="hig-caption-1 bt-pair-card__note bt-pair-card__note--muted"
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
