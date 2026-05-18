import { BrandMark } from "@sotama/ui";
import {
  loadDashboardSnapshot,
  type DashboardSnapshot,
  type PairPanel,
} from "@/lib/dashboard";
import { PairCard } from "@/components/PairCard";
import { BotHealthPill } from "@/components/BotHealthPill";

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
    <main className="bt-shell">
      <header className="bt-header">
        <BrandMark subtitle="Backtest" />
        <BotHealthPill heartbeat={snapshot?.heartbeat ?? null} />
      </header>

      <section style={{ marginBottom: "1.5rem" }}>
        <h1 className="hig-title-1" style={{ margin: 0 }}>Tracked pairs</h1>
        <p className="hig-subheadline" style={{ color: "var(--label-secondary)", margin: "0.25rem 0 0" }}>
          Pyth reference vs Jupiter executable basis. Paper trading only.
        </p>
      </section>

      {loadError ? (
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>Database unreachable</p>
          <p className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}>
            {loadError}
          </p>
        </div>
      ) : !snapshot || snapshot.panels.length === 0 ? (
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>No pairs configured</p>
          <p className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}>
            Pair management is owner-controlled in the bot database until the admin builder ships.
          </p>
        </div>
      ) : (
        <div className="bt-pair-grid">
          {snapshot.panels.map((p: PairPanel) => (
            <PairCard key={p.pair.id} panel={p} />
          ))}
        </div>
      )}
    </main>
  );
}
