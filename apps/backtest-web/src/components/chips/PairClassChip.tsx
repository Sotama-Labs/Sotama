import type { PairClass } from "@sotama/market-core";
import { pairClassLabel } from "@sotama/market-core";

const COLOR: Record<PairClass, string> = {
  BRIDGED_CRYPTO: "var(--indigo)",
  TOKENIZED_EQUITY: "var(--accent)",
  TOKENIZED_METAL: "var(--orange)",
  TOKENIZED_COMMODITY: "var(--orange)",
  TOKENIZED_FX: "var(--teal, var(--accent))",
};

export function PairClassChip({ pairClass }: { pairClass: PairClass }) {
  const color = COLOR[pairClass];
  return (
    <span
      className="hig-caption-1"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0.125rem 0.4375rem",
        borderRadius: "999px",
        color,
        background: "var(--fill-3)",
        fontWeight: 600,
        letterSpacing: "0.012em",
        textTransform: "uppercase",
        fontSize: "0.6875rem",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          display: "inline-block",
        }}
      />
      {pairClassLabel(pairClass)}
    </span>
  );
}
