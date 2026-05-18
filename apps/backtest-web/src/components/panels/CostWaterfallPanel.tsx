import type { CostScenarioDto, CostWaterfall } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { fmtBps, signedColor } from "@/lib/format";

export function CostWaterfallPanel({
  waterfall,
  scenarios,
}: {
  waterfall: CostWaterfall;
  scenarios: readonly CostScenarioDto[];
}) {
  return (
    <Section
      title="Cost waterfall"
      subtitle="From the freshest gross edge down to edge-after-cost. Compare scenarios to see which tails survive Solana fees + slippage."
    >
      <WaterfallBars waterfall={waterfall} />
      <ScenarioComparison scenarios={scenarios} />
    </Section>
  );
}

function WaterfallBars({ waterfall }: { waterfall: CostWaterfall }) {
  const maxMagnitude = Math.max(
    Math.abs(waterfall.grossBps),
    ...waterfall.steps.map((s) => Math.abs(s.bps)),
    1,
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4375rem" }}>
      {waterfall.steps.map((step) => (
        <div
          key={step.code}
          className="bt-waterfall-row"
        >
          <span
            className={`hig-footnote ${
              step.code === "GROSS" || step.code === "EDGE_AFTER_COST" ? "" : ""
            }`}
            style={{
              color:
                step.code === "EDGE_AFTER_COST"
                  ? signedColor(step.bps)
                  : step.code === "GROSS"
                    ? "var(--label-primary)"
                    : "var(--label-secondary)",
              fontWeight: step.code === "GROSS" || step.code === "EDGE_AFTER_COST" ? 600 : 400,
            }}
          >
            {step.label}
          </span>
          <span
            className="hig-footnote bt-num"
            style={{
              color: step.bps > 0 ? "var(--green)" : step.bps < 0 ? "var(--red)" : "var(--label-primary)",
              textAlign: "right",
            }}
          >
            {fmtBps(step.bps)}
          </span>
          <Bar value={step.bps} max={maxMagnitude} />
        </div>
      ))}
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(1, Math.abs(value) / max);
  const color = value > 0 ? "var(--green)" : value < 0 ? "var(--red)" : "var(--label-tertiary)";
  return (
    <div
      style={{
        height: 6,
        background: "var(--fill-4)",
        borderRadius: 4,
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: value < 0 ? `${(1 - pct) * 50}%` : "50%",
          right: value > 0 ? `${(1 - pct) * 50}%` : "50%",
          background: color,
          borderRadius: 4,
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          left: "calc(50% - 0.5px)",
          width: 1,
          background: "var(--separator)",
        }}
      />
    </div>
  );
}

function ScenarioComparison({ scenarios }: { scenarios: readonly CostScenarioDto[] }) {
  return (
    <div
      style={{
        marginTop: "0.875rem",
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(180px, 1fr))`,
        gap: "0.5rem",
      }}
    >
      {scenarios.map((s) => (
        <div
          key={s.name}
          style={{
            padding: "0.625rem 0.75rem",
            background: "var(--fill-4)",
            borderRadius: "var(--radius-control-m)",
            display: "flex",
            flexDirection: "column",
            gap: "0.1875rem",
          }}
        >
          <span
            className="hig-caption-1"
            style={{
              color: "var(--label-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontSize: "0.6875rem",
            }}
          >
            {s.label}
          </span>
          <span
            className="hig-headline bt-num"
            style={{ color: signedColor(s.waterfall.edgeAfterCostBps) }}
          >
            {fmtBps(s.waterfall.edgeAfterCostBps)}
          </span>
          <span
            className="hig-caption-1"
            style={{ color: "var(--label-tertiary)" }}
          >
            {s.description}
          </span>
        </div>
      ))}
    </div>
  );
}
