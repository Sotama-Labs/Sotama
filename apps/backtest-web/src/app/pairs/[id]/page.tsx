import { notFound } from "next/navigation";
import { FreshnessDot, levelForAgeMs } from "@sotama/ui";
import { fetchHealth, fetchPairDetail } from "@/lib/bot-api";
import { BotHealthPill } from "@/components/BotHealthPill";
import { PageHeader } from "@/components/PageHeader";
import { PairClassChip } from "@/components/chips/PairClassChip";
import { ReferenceStatusChip } from "@/components/chips/ReferenceStatusChip";
import { CostWaterfallPanel } from "@/components/panels/CostWaterfallPanel";
import { HoldHorizonPanel } from "@/components/panels/HoldHorizonPanel";
import { OpportunityPanel } from "@/components/panels/OpportunityPanel";
import { PairReadinessPanel } from "@/components/panels/PairReadinessPanel";
import { QualityDistributionPanel } from "@/components/panels/QualityDistributionPanel";
import { QuoteSurfacePanel } from "@/components/panels/QuoteSurfacePanel";
import { RouteStabilityPanel } from "@/components/panels/RouteStabilityPanel";
import { SchedulerTelemetryPanel } from "@/components/panels/SchedulerTelemetryPanel";
import { SignalHistoryPanel } from "@/components/panels/SignalHistoryPanel";
import { StatSummaryPanel } from "@/components/panels/StatSummaryPanel";
import { TimeRegimePanel } from "@/components/panels/TimeRegimePanel";
import { TokenValidationPanel } from "@/components/panels/TokenValidationPanel";
import { VerdictPanel } from "@/components/panels/VerdictPanel";

// Pair detail SSR cache. Hold-horizon replay, stat summary, and route
// stability change on the minute scale at best; the bot caches its
// per-pair response for 5 minutes already.
export const revalidate = 60;

export default async function PairDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: Awaited<ReturnType<typeof fetchPairDetail>> = null;
  let health: Awaited<ReturnType<typeof fetchHealth>> | null = null;
  let loadError: string | null = null;
  try {
    [detail, health] = await Promise.all([
      fetchPairDetail(id),
      fetchHealth().catch(() => null),
    ]);
  } catch (e: any) {
    loadError = String(e?.message ?? e);
  }

  if (loadError) {
    return (
      <main className="bt-page">
        <PageHeader back={{ href: "/", label: "All pairs" }} />
        <div className="bt-empty">
          <p className="hig-headline" style={{ margin: 0 }}>
            Bot unreachable
          </p>
          <p className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.5rem" }}>
            {loadError}
          </p>
        </div>
      </main>
    );
  }

  if (!detail) notFound();

  const ageMs = detail.currentOpportunity.quoteAgeMs ?? detail.quoteAgeMs;
  const level = levelForAgeMs(ageMs);
  const verdict = detail.pair.enabled
    ? detail.verdict
    : {
        ...detail.verdict,
        status: "NOT_READY" as const,
        confidence: "LOW" as const,
        summary: "Pair is paused; the bot is not scheduling feed or route probes.",
        blockers: [
          {
            code: "PAIR_DISABLED",
            detail: "Pair is paused; enable it before expecting Pyth updates or Jupiter route probes.",
          },
        ],
        positives: [],
        recommendedNextAction: "Enable the pair after confirming the token mint and route are intended.",
      };

  return (
    <main className="bt-page">
      <PageHeader
        back={{ href: "/", label: "All pairs" }}
        trailing={<BotHealthPill heartbeat={health?.heartbeat ?? null} />}
      />

      <section style={{ margin: "0.5rem 0 1.25rem" }}>
        <div className="bt-page-title">
          <h1 className="hig-title-1" style={{ margin: 0 }}>
            {detail.displayLabel}
          </h1>
          <FreshnessDot ageMs={ageMs} />
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            {level === "live"
              ? "live"
              : level === "warm"
                ? "lagging"
                : level === "stale"
                  ? "stale"
                  : "no data"}
          </span>
          <PairClassChip pairClass={detail.pairClass} />
          <ReferenceStatusChip status={detail.referenceStatus} />
          {!detail.pair.enabled ? <span className="hig-caption-1 bt-paused-chip">Paused</span> : null}
        </div>
        <p
          className="hig-subheadline bt-page-meta"
          style={{ margin: "0.25rem 0 0" }}
        >
          {detail.pair.base.pythSymbol} · {detail.pair.tokenized.symbol} (
          {detail.pair.tokenized.mint.slice(0, 6)}…{detail.pair.tokenized.mint.slice(-4)}) ·
          {" "}sizes {detail.pair.sizesUsd.map((s) => `$${s.toLocaleString()}`).join(" · ")}
          {!detail.pair.enabled ? " · not scheduled" : ""}
        </p>
      </section>

      <div className="bt-section-stack">
        <div className="bt-detail-top">
          <VerdictPanel verdict={verdict} />
          <OpportunityPanel
            pairLabel={detail.displayLabel}
            opportunity={detail.currentOpportunity}
            diagnosticBuy={detail.bestDiagnosticBuy}
            diagnosticSell={detail.bestDiagnosticSell}
          />
        </div>

        <div className="bt-detail-mid">
          <CostWaterfallPanel
            waterfall={detail.costWaterfall}
            scenarios={detail.costScenarios}
          />
          <RouteStabilityPanel summary={detail.routeStability} />
        </div>

        <PairReadinessPanel matrix={detail.pairReadiness} />
        <TokenValidationPanel snapshot={detail.tokenValidation} />

        <StatSummaryPanel summaries={detail.statSummary} />

        <HoldHorizonPanel rows={detail.holdHorizonReplay} />
        <SignalHistoryPanel
          history={detail.signalHistory}
          profitability={detail.profitability}
        />

        <div className="bt-detail-mid">
          <QualityDistributionPanel rows={detail.qualityDistribution} />
          <TimeRegimePanel rows={detail.timeRegimeSummary} />
        </div>

        <QuoteSurfacePanel pair={detail.pair} rows={detail.quoteSurface} />

        <SchedulerTelemetryPanel
          telemetry={health?.heartbeat?.schedulerTelemetry ?? null}
        />
      </div>

      <footer style={{ marginTop: "2rem" }}>
        <p className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
          Bot last heartbeat: {health?.heartbeat?.observedAt ?? "—"}
        </p>
      </footer>
    </main>
  );
}
