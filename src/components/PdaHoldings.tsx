"use client";

import { usePdaHoldings } from "@/hooks/usePdaHoldings";
import { fmt, shortAddress } from "@/lib/format";
import { isDemoMode } from "@/lib/demo/demo";

/**
 * Inline "this strategy currently holds X TOKEN + Y SOL" summary,
 * followed by a Solscan link to the PDA. Renders nothing when the
 * strategy has neither tokens nor extra SOL — keeps quiet rows quiet.
 *
 * "Holds" = anything beyond the rent-exempt minimum: post-execution
 * output tokens, undeposited dust, partial-fill leftovers, etc. The
 * rent reserved to keep the PDA alive is NOT shown; closing the
 * automation refunds it.
 */
export function PdaHoldings({
  pda,
  refreshKey,
}: {
  pda: string;
  refreshKey?: number | string;
}) {
  const { tokens, extraSol, loading } = usePdaHoldings(pda, { refreshKey });

  if (loading) return null;
  if (tokens.length === 0 && extraSol <= 0) {
    // Demo mode: the PDA is a dummy address that doesn't exist on-chain,
    // so a Solscan link would just 404 — render nothing instead.
    if (isDemoMode()) return null;
    // Even with no holdings, surface the Solscan link — it's how the
    // user inspects the PDA's history directly.
    return (
      <a
        href={`https://solscan.io/account/${pda}`}
        target="_blank"
        rel="noreferrer"
        className="hig-footnote"
        style={{
          color: "var(--label-tertiary)",
          textDecoration: "none",
        }}
        title="View this strategy's PDA on Solscan"
      >
        Solscan ↗
      </a>
    );
  }

  return (
    <span
      style={{
        display: "inline-flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "0.375rem",
      }}
    >
      <span style={{ color: "var(--label-tertiary)" }}>· holds</span>
      {extraSol > 0 && (
        <span style={{ color: "var(--label-secondary)" }}>
          {fmt(extraSol, extraSol < 0.01 ? 4 : 3)} SOL
        </span>
      )}
      {tokens.map((h, i) => (
        <span key={h.mint} style={{ color: "var(--label-secondary)" }}>
          {i > 0 || extraSol > 0 ? "· " : ""}
          {fmt(h.uiAmount, h.uiAmount < 1 ? 4 : 2)}{" "}
          {h.token ? h.token.symbol : shortAddress(h.mint)}
        </span>
      ))}
      {/* Dummy demo PDAs don't exist on-chain — skip the (dead) Solscan link. */}
      {!isDemoMode() && (
        <a
          href={`https://solscan.io/account/${pda}`}
          target="_blank"
          rel="noreferrer"
          style={{
            color: "var(--accent)",
            textDecoration: "none",
            marginLeft: "0.25rem",
          }}
          title="View this strategy's PDA on Solscan"
        >
          Solscan ↗
        </a>
      )}
    </span>
  );
}
