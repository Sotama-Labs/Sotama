import type { DisplayBasisInterpretation } from "@sotama/market-core";
import { fmtBps } from "@/lib/format";

export function BasisChip({
  bps,
  interpretation,
  label,
}: {
  bps: number | null | undefined;
  interpretation: DisplayBasisInterpretation | null | undefined;
  label?: string;
}) {
  const color =
    interpretation === "ONCHAIN_CHEAP"
      ? "var(--green)"
      : interpretation === "ONCHAIN_RICH"
        ? "var(--accent)"
        : interpretation === "AT_PARITY"
          ? "var(--label-secondary)"
          : "var(--label-tertiary)";
  const detail =
    interpretation === "ONCHAIN_CHEAP"
      ? "onchain cheap"
      : interpretation === "ONCHAIN_RICH"
        ? "onchain rich"
        : interpretation === "AT_PARITY"
          ? "at parity"
          : "—";
  return (
    <span
      className="hig-caption-1"
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 6,
        color,
        fontWeight: 600,
      }}
    >
      <span className="bt-num">{fmtBps(bps)}</span>
      <span
        style={{
          color: "var(--label-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontSize: "0.6875rem",
        }}
      >
        {label ?? detail}
      </span>
    </span>
  );
}
