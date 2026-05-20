import type { PairPanelDto } from "@sotama/market-core";
import { PairCard } from "@/components/PairCard";
import {
  VERDICT_ORDER,
  verdictColor,
  verdictGroupHeadline,
} from "@/lib/verdict";

export function PairOverview({ panels }: { panels: readonly PairPanelDto[] }) {
  const grouped = groupByVerdict(panels);
  const summary = overviewSummary(panels);
  return (
    <div className="bt-section-stack">
      <div className="bt-overview-summary" aria-label="Pair overview summary">
        {summary.map((tile) => (
          <div key={tile.label} className="bt-overview-summary__tile">
            <span className="hig-caption-1 bt-overview-summary__label">
              {tile.label}
            </span>
            <span className="hig-title-3 bt-num bt-overview-summary__value">
              {tile.value}
            </span>
            <span className="hig-caption-1 bt-overview-summary__hint">
              {tile.hint}
            </span>
          </div>
        ))}
      </div>
      {VERDICT_ORDER.map((status) => {
        const items = grouped.get(status) ?? [];
        if (items.length === 0) return null;
        return (
          <section key={status} className="bt-group">
            <header
              className="bt-group-header"
            >
              <h2
                className="hig-footnote bt-group-title"
                style={{
                  color: verdictColor(status),
                }}
              >
                {verdictGroupHeadline(status)}
              </h2>
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {items.length} pair{items.length === 1 ? "" : "s"}
              </span>
            </header>
            <div className="bt-pair-grid">
              {items.map((panel) => (
                <PairCard key={panel.pair.id} panel={panel} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function groupByVerdict(
  panels: readonly PairPanelDto[],
): Map<PairPanelDto["verdict"]["status"], PairPanelDto[]> {
  const out = new Map<PairPanelDto["verdict"]["status"], PairPanelDto[]>();
  for (const status of VERDICT_ORDER) out.set(status, []);
  for (const panel of panels) {
    const arr = out.get(panel.verdict.status) ?? [];
    arr.push(panel);
    out.set(panel.verdict.status, arr);
  }
  for (const arr of out.values()) {
    arr.sort((a, b) => {
      // Inside each group, candidates with the freshest live quote first.
      const ageA = a.currentOpportunity.quoteAgeMs ?? Number.POSITIVE_INFINITY;
      const ageB = b.currentOpportunity.quoteAgeMs ?? Number.POSITIVE_INFINITY;
      return ageA - ageB;
    });
  }
  return out;
}

function overviewSummary(panels: readonly PairPanelDto[]): Array<{
  label: string;
  value: number;
  hint: string;
}> {
  const live = panels.filter((panel) => panel.currentOpportunity.hasLiveOpportunity).length;
  const active = panels.filter((panel) => panel.pair.enabled).length;
  const disabled = panels.length - active;
  const notReady = panels.filter(
    (panel) => panel.pair.enabled && panel.verdict.status === "NOT_READY",
  ).length;
  const collecting = panels.filter((panel) => panel.verdict.status === "COLLECT_MORE").length;
  return [
    { label: "Active", value: active, hint: "scheduled by bot" },
    { label: "Live", value: live, hint: "paired executable rows" },
    { label: "Collecting", value: collecting, hint: "routes exist, samples low" },
    { label: "Blocked", value: notReady, hint: "feed, route, or mint gap" },
    { label: "Paused", value: disabled, hint: "not scheduled" },
  ];
}
