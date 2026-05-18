import type { PairPanelDto } from "@sotama/market-core";
import { PairCard } from "@/components/PairCard";
import {
  VERDICT_ORDER,
  verdictColor,
  verdictGroupHeadline,
} from "@/lib/verdict";

export function PairOverview({ panels }: { panels: readonly PairPanelDto[] }) {
  const grouped = groupByVerdict(panels);
  return (
    <div className="bt-section-stack">
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
