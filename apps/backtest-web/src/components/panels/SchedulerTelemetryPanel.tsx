import type { SchedulerTelemetryDto } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { StatGrid } from "@/components/ui/StatGrid";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { fmtNumber, fmtPct } from "@/lib/format";

type PerPair = SchedulerTelemetryDto["perPair"][number];

export function SchedulerTelemetryPanel({
  telemetry,
}: {
  telemetry: SchedulerTelemetryDto | null;
}) {
  if (!telemetry) {
    return (
      <Section title="Scheduler telemetry" subtitle="60-second rolling counters from the bot.">
        <p className="hig-footnote" style={{ color: "var(--label-secondary)", margin: 0 }}>
          Telemetry unavailable — the bot has not yet reported.
        </p>
      </Section>
    );
  }
  const totalDropped =
    telemetry.droppedDueToRps1m +
    telemetry.droppedDueToStalePyth1m +
    telemetry.droppedDueToMarketSession1m;
  return (
    <Section
      title="Scheduler telemetry"
      subtitle="60-second rolling counters: which pairs are being starved and why."
    >
      <StatGrid
        minTileWidth={140}
        tiles={[
          { label: "Scheduled", value: fmtNumber(telemetry.scheduledQuotes1m) },
          {
            label: "Admitted",
            value: fmtNumber(telemetry.admittedQuotes1m),
            hint:
              telemetry.scheduledQuotes1m === 0
                ? "—"
                : fmtPct(telemetry.admittedQuotes1m / telemetry.scheduledQuotes1m),
          },
          {
            label: "Dropped (RPS)",
            value: fmtNumber(telemetry.droppedDueToRps1m),
            color: telemetry.droppedDueToRps1m > 0 ? "var(--orange)" : undefined,
          },
          {
            label: "Stale Pyth",
            value: fmtNumber(telemetry.droppedDueToStalePyth1m),
            color: telemetry.droppedDueToStalePyth1m > 0 ? "var(--orange)" : undefined,
          },
          {
            label: "Off-session",
            value: fmtNumber(telemetry.droppedDueToMarketSession1m),
            color: telemetry.droppedDueToMarketSession1m > 0 ? "var(--label-secondary)" : undefined,
          },
          {
            label: "Total dropped",
            value: fmtNumber(totalDropped),
          },
        ]}
      />
      {telemetry.perPair.length > 0 ? (
        <div style={{ marginTop: "0.875rem" }}>
          <DataTable<PerPair>
            rowKey={(r) => r.pairId}
            columns={columns()}
            rows={telemetry.perPair}
          />
        </div>
      ) : null}
    </Section>
  );
}

function columns(): Column<PerPair>[] {
  return [
    { key: "pair", header: "Pair", render: (r) => r.pairId },
    { key: "sched", header: "Scheduled", numeric: true, render: (r) => fmtNumber(r.scheduled) },
    { key: "adm", header: "Admitted", numeric: true, render: (r) => fmtNumber(r.admitted) },
    {
      key: "rps",
      header: "Drop RPS",
      numeric: true,
      render: (r) => fmtNumber(r.droppedDueToRps),
      color: (r) => (r.droppedDueToRps > 0 ? "var(--orange)" : undefined),
    },
    {
      key: "stale",
      header: "Drop stale Pyth",
      numeric: true,
      render: (r) => fmtNumber(r.droppedDueToStalePyth),
      color: (r) => (r.droppedDueToStalePyth > 0 ? "var(--orange)" : undefined),
    },
    {
      key: "session",
      header: "Drop off-session",
      numeric: true,
      render: (r) => fmtNumber(r.droppedDueToMarketSession),
    },
  ];
}
