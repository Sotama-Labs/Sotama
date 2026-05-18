import type { PairResearchVerdict } from "@sotama/market-core";
import { Section } from "@/components/ui/Section";
import { VerdictChip } from "@/components/chips/VerdictChip";
import { fmtDuration, fmtNumber } from "@/lib/format";

export function VerdictPanel({ verdict }: { verdict: PairResearchVerdict }) {
  return (
    <Section
      title="Research verdict"
      subtitle={`${fmtNumber(verdict.cleanSampleCount)} live-eligible samples over ${fmtDuration(
        verdict.cleanWindowMs,
      )} · cost scenario ${verdict.costScenarioName}`}
      action={<VerdictChip verdict={verdict} showConfidence />}
    >
      <p
        className="hig-body"
        style={{ margin: "0 0 0.75rem", color: "var(--label-primary)" }}
      >
        {verdict.summary}
      </p>
      <div
        className="bt-reason-grid"
      >
        <ReasonList
          tone="blockers"
          title="Blockers"
          reasons={verdict.blockers}
        />
        <ReasonList
          tone="positives"
          title="Positives"
          reasons={verdict.positives}
        />
      </div>
      <div
        className="bt-next-action"
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
          Next action
        </span>
        <span className="hig-subheadline" style={{ color: "var(--label-primary)" }}>
          {verdict.recommendedNextAction}
        </span>
      </div>
    </Section>
  );
}

function ReasonList({
  title,
  reasons,
  tone,
}: {
  title: string;
  reasons: PairResearchVerdict["blockers"];
  tone: "blockers" | "positives";
}) {
  const color = tone === "blockers" ? "var(--red)" : "var(--green)";
  return (
    <div>
      <p
        className="hig-caption-1"
        style={{
          margin: "0 0 0.375rem",
          color: "var(--label-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          fontSize: "0.6875rem",
        }}
      >
        {title}
      </p>
      {reasons.length === 0 ? (
        <p
          className="hig-footnote"
          style={{ color: "var(--label-secondary)", margin: 0 }}
        >
          {tone === "blockers" ? "None" : "—"}
        </p>
      ) : (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            gap: "0.375rem",
          }}
        >
          {reasons.slice(0, 4).map((r) => (
            <li
              key={r.code}
              className="hig-footnote"
              style={{ color: "var(--label-primary)", display: "flex", gap: 6 }}
            >
              <span
                aria-hidden
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: color,
                  marginTop: 6,
                  flexShrink: 0,
                }}
              />
              <span>{r.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
