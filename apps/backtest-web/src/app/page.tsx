import { BotHealthPill } from "@/components/BotHealthPill";
import { PageHeader } from "@/components/PageHeader";
import { PairOverview } from "@/components/PairOverview";
import { SchedulerTelemetryPanel } from "@/components/panels/SchedulerTelemetryPanel";
import { loadDashboardSnapshot, type DashboardSnapshot } from "@/lib/dashboard";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function HomePage() {
  let snapshot: DashboardSnapshot | null = null;
  let loadError: string | null = null;
  try {
    snapshot = await loadDashboardSnapshot();
  } catch (e: any) {
    loadError = String(e?.message ?? e);
  }

  return (
    <main className="bt-page">
      <PageHeader trailing={<BotHealthPill heartbeat={snapshot?.heartbeat ?? null} />} />

      <section style={{ margin: "0.5rem 0 1.5rem" }}>
        <h1 className="hig-title-1" style={{ margin: 0 }}>
          Stat-arb research desk
        </h1>
        <p className="hig-subheadline bt-page-meta" style={{ margin: "0.25rem 0 0" }}>
          Onchain Solana asset / underlying reference. Paper-trade only — no live execution.
        </p>
      </section>

      {loadError ? (
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>
            Bot unreachable
          </p>
          <p
            className="hig-footnote"
            style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}
          >
            {loadError}
          </p>
        </div>
      ) : !snapshot || snapshot.panels.length === 0 ? (
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>
            No pairs configured
          </p>
          <p
            className="hig-footnote"
            style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}
          >
            Pair management is owner-controlled in the bot database until the admin builder ships.
          </p>
        </div>
      ) : (
        <div className="bt-section-stack">
          <PairOverview panels={snapshot.panels} />
          <SchedulerTelemetryPanel telemetry={snapshot.schedulerTelemetry ?? null} />
        </div>
      )}
    </main>
  );
}
