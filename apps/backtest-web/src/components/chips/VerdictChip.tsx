import type { PairResearchVerdict } from "@sotama/market-core";
import { confidenceDots, verdictBackground, verdictColor, verdictLabel } from "@/lib/verdict";

export function VerdictChip({
  verdict,
  showConfidence = false,
}: {
  verdict: PairResearchVerdict;
  showConfidence?: boolean;
}) {
  return (
    <span
      className="hig-caption-1"
      title={verdict.summary}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0.1875rem 0.5rem",
        borderRadius: "999px",
        color: verdictColor(verdict.status),
        background: verdictBackground(verdict.status),
        fontWeight: 600,
        letterSpacing: "0.012em",
      }}
    >
      {verdictLabel(verdict.status)}
      {showConfidence ? (
        <span
          aria-label={`confidence ${verdict.confidence.toLowerCase()}`}
          style={{ opacity: 0.9, fontSize: "0.6875rem", letterSpacing: "0.1em" }}
        >
          {confidenceDots(verdict)}
        </span>
      ) : null}
    </span>
  );
}
