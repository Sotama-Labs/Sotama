"use client";

import { useEffect, useState } from "react";
import type { DraftTokenPrice, TokenRef } from "@/lib/types";
import { resolveOracleForToken } from "@/lib/oracles";
import { usePythPrice } from "@/hooks/usePythPrice";
import { formatPythPrice } from "@/lib/format";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

type Stage = "form" | "pick-token" | "pick-quote";

export function TokenPriceEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftTokenPrice;
  onChange: (next: DraftTokenPrice) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [stage, setStage] = useState<Stage>("form");
  const [resolving, setResolving] = useState(false);

  const feedId = draft.oracle?.kind === "pyth" ? draft.oracle.feedId : null;
  const { price: livePrice, status } = usePythPrice(feedId);

  useEffect(() => {
    if (!draft.token) return;
    if (
      draft.oracle &&
      ((draft.oracle.kind === "pyth" && draft.oracle.symbol === `Crypto.${draft.token.symbol}/USD`) ||
        draft.oracle.symbol === draft.token.symbol)
    )
      return;
    let alive = true;
    setResolving(true);
    resolveOracleForToken(draft.token).then((oracle) => {
      if (!alive) return;
      setResolving(false);
      onChange({ ...draft, oracle });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.token?.mint]);

  if (stage === "pick-token") {
    return (
      <TokenPicker
        title="Track which token"
        selected={draft.token}
        onBack={() => setStage("form")}
        onSelect={(token) => {
          onChange({ ...draft, token, oracle: null });
          setStage("form");
        }}
      />
    );
  }
  if (stage === "pick-quote") {
    return (
      <TokenPicker
        title="Quote in"
        selected={draft.quote.kind === "token" ? (draft.quote as TokenRef) : null}
        onBack={() => setStage("form")}
        onSelect={(token) => {
          onChange({ ...draft, quote: { kind: "token", ...token } });
          setStage("form");
        }}
      />
    );
  }

  const ready =
    draft.token != null && draft.threshold != null && draft.threshold > 0 && draft.oracle != null;

  return (
    <EditorShell title="When this happens" side="if" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      <FieldRow label="Token">
        <button
          onClick={() => setStage("pick-token")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.5rem 0.625rem",
            background: "var(--fill-4)",
            border: "0.5px solid var(--separator)",
            borderRadius: "0.5rem",
          }}
        >
          {draft.token ? (
            <TokenPill token={draft.token} />
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick a token…
            </span>
          )}
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            change
          </span>
        </button>
      </FieldRow>

      <FieldRow label="Direction">
        <div
          style={{
            display: "inline-flex",
            padding: "0.125rem",
            background: "var(--fill-3)",
            borderRadius: "0.5rem",
            gap: "0.125rem",
            width: "fit-content",
          }}
        >
          {(["below", "above"] as const).map((c) => {
            const sel = draft.comparator === c;
            return (
              <button
                key={c}
                onClick={() => onChange({ ...draft, comparator: c })}
                className="hig-footnote"
                style={{
                  padding: "0.25rem 0.625rem",
                  borderRadius: "0.375rem",
                  background: sel ? "var(--bg-system)" : "transparent",
                  color: sel ? "var(--label-primary)" : "var(--label-secondary)",
                  fontWeight: 500,
                  boxShadow: sel ? "var(--shadow-1)" : "none",
                  transition: "background 120ms",
                }}
              >
                {c === "below" ? "Drops below" : "Goes above"}
              </button>
            );
          })}
        </div>
      </FieldRow>

      <FieldRow label={`Threshold (${draft.quote.kind === "usd" ? "USD" : draft.quote.symbol})`}>
        <AmountInput
          value={draft.threshold}
          token={null}
          onChange={(v) => onChange({ ...draft, threshold: v })}
          onCommit={ready ? onConfirm : undefined}
          unit={draft.quote.kind === "usd" ? "USD" : draft.quote.symbol}
          placeholder={livePrice != null ? formatPythPrice(livePrice) : "0.00"}
          annotation={(() => {
            if (
              draft.quote.kind !== "usd" ||
              livePrice == null ||
              livePrice <= 0 ||
              draft.threshold == null ||
              draft.threshold <= 0
            )
              return null;
            const pct = ((draft.threshold - livePrice) / livePrice) * 100;
            if (Math.abs(pct) < 0.05) return null;
            const positive = pct > 0;
            const sign = positive ? "+" : "−";
            const magnitude = Math.abs(pct);
            const formatted = magnitude >= 100 ? magnitude.toFixed(0) : magnitude.toFixed(1);
            return (
              <span
                className="hig-footnote"
                style={{
                  color: positive ? "var(--green)" : "var(--red)",
                  fontWeight: 600,
                  fontFeatureSettings: '"tnum"',
                  whiteSpace: "nowrap",
                }}
              >
                ({sign}
                {formatted}%)
              </span>
            );
          })()}
          presets={
            livePrice != null
              ? [-15, -5, 5, 15].map((pct) => {
                  const sign = pct > 0 ? "+" : "−";
                  const label = `${sign}${Math.abs(pct)}%`;
                  return {
                    label,
                    apply: (current: number | null) => {
                      const base = current && current > 0 ? current : livePrice;
                      const raw = base * (1 + pct / 100);
                      const decimals =
                        raw >= 100 ? 0 : raw >= 1 ? 2 : raw >= 0.01 ? 4 : 6;
                      const factor = Math.pow(10, decimals);
                      return Math.round(raw * factor) / factor;
                    },
                  };
                })
              : undefined
          }
        />
      </FieldRow>

      <div
        className="hig-caption-1"
        style={{
          color: "var(--label-tertiary)",
          fontFeatureSettings: '"tnum"',
          padding: "0 0.125rem",
        }}
      >
        {resolving
          ? "Resolving oracle…"
          : draft.oracle?.kind === "pyth"
          ? `Pyth · ${draft.oracle.symbol}${
              livePrice != null ? ` · live $${formatPythPrice(livePrice)}` : ""
            }${status === "polling" ? " · polling" : ""}`
          : draft.oracle?.kind === "switchboard_pending"
          ? "No Pyth feed — keeper will resolve via Switchboard"
          : draft.token
          ? "Looking up oracle…"
          : "Pick a token to see live price"}
      </div>

      {draft.token && (
        <button
          onClick={() => setStage("pick-quote")}
          className="hig-caption-1"
          style={{
            color: "var(--accent)",
            fontWeight: 500,
            alignSelf: "flex-start",
            padding: "0.125rem 0.125rem",
          }}
        >
          {draft.quote.kind === "usd" ? "Quote in another token" : `Quote: ${draft.quote.symbol} — change`}
        </button>
      )}
    </EditorShell>
  );
}
