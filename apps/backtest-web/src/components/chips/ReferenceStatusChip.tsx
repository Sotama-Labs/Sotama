import type { ReferenceStatus } from "@sotama/market-core";
import { referenceStatusLabel } from "@sotama/market-core";

const FG: Record<ReferenceStatus, string> = {
  LIVE_REFERENCE: "var(--green)",
  REFERENCE_CLOSED: "var(--label-secondary)",
  REFERENCE_STALE: "var(--orange)",
  REFERENCE_UNCERTAIN: "var(--label-tertiary)",
};

export function ReferenceStatusChip({ status }: { status: ReferenceStatus }) {
  return (
    <span
      className="hig-caption-1"
      title={referenceStatusLabel(status)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0.125rem 0.4375rem",
        borderRadius: "999px",
        color: FG[status],
        background: "var(--fill-3)",
        fontWeight: 500,
        letterSpacing: "0.012em",
        textTransform: "uppercase",
        fontSize: "0.6875rem",
      }}
    >
      {referenceStatusLabel(status)}
    </span>
  );
}
