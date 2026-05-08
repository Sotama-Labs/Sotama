"use client";

import { CLUSTER, CLUSTER_LABEL } from "@/lib/rpc";

/**
 * Cluster indicator chip rendered in the top nav. Shows `Mainnet`
 * (green) or `Devnet` (orange) based on `NEXT_PUBLIC_SOLANA_CLUSTER`.
 *
 * **Why this matters:** deposits to the wrong cluster are
 * unrecoverable. Sotama doesn't have a network switcher in-app — the
 * cluster is fixed at build time per env var. Users running both
 * environments need a glanceable indicator so they don't sign a
 * mainnet tx while looking at devnet's UI (or vice versa).
 */
export function NetworkBadge() {
  const isMainnet = CLUSTER === "mainnet-beta";
  const label = CLUSTER_LABEL[CLUSTER];
  return (
    <div
      role="status"
      aria-label={`${label} network`}
      title={`Sotama is connected to ${label}. Set NEXT_PUBLIC_SOLANA_CLUSTER to switch.`}
      className="hig-caption-1"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.375rem",
        padding: "0.25rem 0.5rem",
        borderRadius: "999px",
        background: isMainnet
          ? "color-mix(in oklab, #16a34a 14%, transparent)"
          : "color-mix(in oklab, #f59e0b 14%, transparent)",
        border: `0.5px solid ${
          isMainnet
            ? "color-mix(in oklab, #16a34a 40%, transparent)"
            : "color-mix(in oklab, #f59e0b 40%, transparent)"
        }`,
        color: isMainnet ? "#15803d" : "#b45309",
        fontWeight: 600,
        letterSpacing: "0.02em",
        textTransform: "uppercase",
        fontSize: "0.6875rem",
        userSelect: "none",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "0.375rem",
          height: "0.375rem",
          borderRadius: "999px",
          background: isMainnet ? "#16a34a" : "#f59e0b",
          boxShadow: isMainnet
            ? "0 0 0 2px color-mix(in oklab, #16a34a 25%, transparent)"
            : "0 0 0 2px color-mix(in oklab, #f59e0b 25%, transparent)",
        }}
      />
      {label}
    </div>
  );
}
