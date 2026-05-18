import type { QuoteQualityStatus } from "@sotama/market-core";

const LABEL: Record<QuoteQualityStatus, string> = {
  LIVE_ELIGIBLE: "Live",
  STALE_PYTH: "Stale Pyth",
  STALE_BASIS: "Stale basis",
  QUOTE_LATENCY_TOO_HIGH: "Slow quote",
  MISSING_EXIT_QUOTE: "No exit quote",
  UNKNOWN_ROUTER: "Unknown router",
  ROUTE_UNSTABLE: "Route unstable",
  MARKET_SESSION_INVALID: "Off-session",
  PRICE_IMPACT_TOO_HIGH: "Impact too high",
  PYTH_CONFIDENCE_TOO_WIDE: "Pyth conf wide",
  DECIMALS_UNVERIFIED: "Decimals unverified",
};

const COLOR: Record<QuoteQualityStatus, string> = {
  LIVE_ELIGIBLE: "var(--green)",
  STALE_PYTH: "var(--red)",
  STALE_BASIS: "var(--red)",
  QUOTE_LATENCY_TOO_HIGH: "var(--orange)",
  MISSING_EXIT_QUOTE: "var(--orange)",
  UNKNOWN_ROUTER: "var(--label-secondary)",
  ROUTE_UNSTABLE: "var(--orange)",
  MARKET_SESSION_INVALID: "var(--label-secondary)",
  PRICE_IMPACT_TOO_HIGH: "var(--orange)",
  PYTH_CONFIDENCE_TOO_WIDE: "var(--orange)",
  DECIMALS_UNVERIFIED: "var(--red)",
};

export function qualityLabel(status: QuoteQualityStatus): string {
  return LABEL[status];
}

export function qualityColor(status: QuoteQualityStatus): string {
  return COLOR[status];
}

export function QualityChip({
  status,
  reason,
}: {
  status: QuoteQualityStatus;
  reason?: string;
}) {
  return (
    <span
      className="hig-caption-1"
      title={reason ?? LABEL[status]}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0.125rem 0.4375rem",
        borderRadius: "999px",
        color: COLOR[status],
        background: "var(--fill-3)",
        fontWeight: 500,
        letterSpacing: "0.012em",
        whiteSpace: "nowrap",
        fontSize: "0.6875rem",
      }}
    >
      {LABEL[status]}
    </span>
  );
}
