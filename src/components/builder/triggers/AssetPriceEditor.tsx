"use client";

import { useEffect, useMemo, useState } from "react";
import type { AssetRef, DraftAssetPrice, OracleSource } from "@/lib/types";
import { resolveOracleForPair } from "@/lib/oracles";
import { usePythPrice } from "@/hooks/usePythPrice";
import { useJupiterPrice } from "@/hooks/useJupiterPrice";
import { formatPythPrice } from "@/lib/format";
import { AssetPicker } from "../AssetPicker";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

type Stage = "form" | "pick-asset" | "pick-quote";

export function AssetPriceEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
}: {
  draft: DraftAssetPrice;
  onChange: (next: DraftAssetPrice) => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [stage, setStage] = useState<Stage>("form");
  const [resolving, setResolving] = useState(false);
  // Resolved oracle for the QUOTE asset (only used when we need a
  // quote/USD price for an inferred pair ratio). Holds a Pyth feed id or
  // a Jupiter mint — whichever provider resolves the quote — so the
  // live preview works whether the quote leg is on Pyth or Jupiter.
  const [quoteOracle, setQuoteOracle] = useState<OracleSource | null>(null);

  // Key used to detect quote changes in the effect dep array
  const quoteKey = draft.quote.kind === "usd" ? "usd" : draft.quote.asset.symbol;

  // Whether the base oracle's price is already in the user's chosen
  // pair units. When false, we compute base/USD ÷ quote/USD to get the
  // live preview ratio.
  //
  //  • USD quote: any oracle's USD price is direct.
  //  • Pyth pair feed (FX.AUD/JPY) ending with "/<quote>": direct.
  //  • Pyth inverted feed (FX.USD/SGD for SGD): pythPrice already does
  //    1/raw, so direct from the preview's perspective.
  //  • Jupiter base + non-USD quote: NOT direct — Jupiter prices in USD
  //    only, so we need a quote/USD price to infer the ratio.
  const quoteSymbol = draft.quote.kind === "usd"
    ? "USD"
    : draft.quote.asset.displaySymbol.toUpperCase();
  const isDirectPair = useMemo(() => {
    if (draft.quote.kind === "usd") return true;
    if (!draft.oracle) return true;
    if (draft.oracle.kind === "jupiter") return false;
    if (draft.oracle.kind !== "pyth") return true;
    if (draft.oracle.inverted) return true;
    return draft.oracle.symbol.toUpperCase().endsWith(`/${quoteSymbol}`);
  }, [draft.oracle, draft.quote.kind, quoteSymbol]);

  // Base feed: always the oracle feedId (direct pair OR base/USD)
  const baseFeedId = draft.oracle?.kind === "pyth" ? draft.oracle.feedId : null;
  const { price: pythRawPrice } = usePythPrice(baseFeedId);

  // When Pyth quotes the pair as USD/X (SGD, JPY, …) the resolver flags
  // it inverted; we display 1/raw so the user always sees "asset price
  // in USD". The on-chain trigger handles inversion via flipped
  // comparator + inverted threshold (see mapTriggerToIx).
  const pythInverted = draft.oracle?.kind === "pyth" && draft.oracle.inverted === true;
  const pythPrice = useMemo(() => {
    if (pythRawPrice == null) return null;
    if (!pythInverted) return pythRawPrice;
    if (pythRawPrice === 0) return null;
    return 1 / pythRawPrice;
  }, [pythRawPrice, pythInverted]);

  // Jupiter live price for tokens without a Pyth feed. Mutually
  // exclusive with the Pyth subscription above — only one is active
  // for any given asset, matching the on-chain `source` byte.
  const jupiterMint = draft.oracle?.kind === "jupiter" ? draft.oracle.mint : null;
  const { price: jupiterUsdPrice } = useJupiterPrice(jupiterMint);

  const baseOrPairPrice = pythPrice ?? jupiterUsdPrice;

  // Quote/USD price — Pyth or Jupiter, whichever resolved for the quote
  // asset. Only subscribed when an inferred ratio is needed.
  const quotePythFeedId =
    !isDirectPair && quoteOracle?.kind === "pyth" ? quoteOracle.feedId : null;
  const quoteJupiterMint =
    !isDirectPair && quoteOracle?.kind === "jupiter" ? quoteOracle.mint : null;
  const { price: quotePythRaw } = usePythPrice(quotePythFeedId);
  const { price: quoteJupiterPrice } = useJupiterPrice(quoteJupiterMint);
  const quoteInverted =
    quoteOracle?.kind === "pyth" && quoteOracle.inverted === true;
  const quoteUsdPrice = useMemo(() => {
    if (quotePythRaw != null) {
      if (!quoteInverted) return quotePythRaw;
      if (quotePythRaw === 0) return null;
      return 1 / quotePythRaw;
    }
    return quoteJupiterPrice;
  }, [quotePythRaw, quoteInverted, quoteJupiterPrice]);

  // Live pair price: direct feed or inferred ratio
  const pairPrice = useMemo(() => {
    if (isDirectPair) return baseOrPairPrice;
    if (baseOrPairPrice == null || quoteUsdPrice == null || quoteUsdPrice === 0) return null;
    return baseOrPairPrice / quoteUsdPrice;
  }, [isDirectPair, baseOrPairPrice, quoteUsdPrice]);

  // Resolve oracle whenever the selected asset or quote changes
  useEffect(() => {
    if (!draft.asset) return;
    let alive = true;
    setResolving(true);

    async function run() {
      const asset = draft.asset!;
      const quote = draft.quote;

      const oracle = await resolveOracleForPair(asset, quote);
      if (!alive) return;

      // We need a quote/USD price whenever the base oracle's price
      // isn't already in the user's chosen pair units. That's true for
      // ANY base oracle (Pyth or Jupiter) when the quote is non-USD and
      // the resolved feed isn't a direct/inverted Pyth pair.
      const quoteSym = quote.kind === "asset"
        ? quote.asset.displaySymbol.toUpperCase()
        : "USD";
      const oracleIsDirectPair =
        oracle.kind === "pyth" &&
        (oracle.inverted === true ||
          oracle.symbol.toUpperCase().endsWith(`/${quoteSym}`));
      const needsInferred = quote.kind === "asset" && !oracleIsDirectPair;
      if (needsInferred && quote.kind === "asset") {
        const qOracle = await resolveOracleForPair(quote.asset, { kind: "usd" });
        if (alive) setQuoteOracle(qOracle);
      } else {
        setQuoteOracle(null);
      }

      if (!alive) return;
      setResolving(false);
      onChange({ ...draft, oracle });
    }

    run();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.asset?.symbol, quoteKey]);

  if (stage === "pick-asset") {
    // Greyout the asset already used as quote (if non-USD) so users
    // can't accidentally end up with SOL/SOL or EUR/EUR.
    const baseDisabled =
      draft.quote.kind === "asset" ? [draft.quote.asset.symbol] : [];
    return (
      <AssetPicker
        title="Track which asset"
        selected={draft.asset}
        onBack={() => setStage("form")}
        disabledSymbols={baseDisabled}
        onSelect={(asset) => {
          onChange({ ...draft, asset, oracle: null });
          setStage("form");
        }}
      />
    );
  }

  if (stage === "pick-quote") {
    // Greyout the base asset so the user can't quote it against itself.
    // The list also includes USD (in FX): if the base is USD, USD is
    // disabled here too.
    const quoteDisabled = draft.asset ? [draft.asset.symbol] : [];
    return (
      <AssetPicker
        title="Quote asset"
        selected={draft.quote.kind === "asset" ? draft.quote.asset : null}
        onBack={() => setStage("form")}
        disabledSymbols={quoteDisabled}
        onSelect={(asset: AssetRef) => {
          // Picking USD as a quote collapses to the canonical USD-quote
          // path so the existing single-feed trigger logic handles it.
          if (asset.symbol === "USD") {
            onChange({ ...draft, quote: { kind: "usd" } });
          } else {
            onChange({ ...draft, quote: { kind: "asset", asset }, oracle: null });
          }
          setStage("form");
        }}
      />
    );
  }

  const ready =
    draft.asset != null &&
    draft.threshold != null &&
    draft.threshold > 0 &&
    draft.oracle != null &&
    // switchboard_pending means no resolver matched. Block confirm so
    // the user can't deploy an automation that will never fire.
    draft.oracle.kind !== "switchboard_pending";

  const thresholdLabel =
    draft.quote.kind === "usd" ? "USD" : draft.quote.asset.displaySymbol;

  // Status caption text — describes the source/state of the feed only.
  // The live price itself is rendered once below the threshold input
  // ("Current: $X.XX"), so showing it here too produced duplicate
  // numbers in the UI.
  // Status text only shows for non-live states. Once a live price is
  // available, the "(Live)" marker rendered next to the price is the
  // only signal we need.
  const statusText = (() => {
    if (!draft.asset) return "Pick an asset to continue";
    if (resolving) return "Looking up live price…";
    if (!draft.oracle) return "Looking up live price…";
    if (draft.oracle.kind === "switchboard_pending")
      return "No live price available — pick a different asset to continue";
    return null;
  })();

  // Pair price caption shown below threshold input
  const pairCaption = (() => {
    if (pairPrice == null) return null;
    if (draft.quote.kind === "usd") return `$${formatPythPrice(pairPrice)}`;
    const sym = draft.quote.asset.displaySymbol;
    const prefix = isDirectPair ? "" : "≈ ";
    return `${prefix}${formatPythPrice(pairPrice)} ${sym}`;
  })();

  return (
    <EditorShell title="When this happens" side="if" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      <FieldRow label="Asset">
        <button
          onClick={() => setStage("pick-asset")}
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
          {draft.asset ? (
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.375rem" }}>
              <span className="hig-footnote" style={{ fontWeight: 600, color: "var(--label-primary)" }}>
                {draft.asset.displaySymbol}
              </span>
              {draft.asset.name && (
                <span className="hig-caption-2" style={{ color: "var(--label-secondary)" }}>
                  {draft.asset.name}
                </span>
              )}
            </div>
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick an asset…
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

      <FieldRow label={`Threshold (${thresholdLabel})`}>
        <AmountInput
          value={draft.threshold}
          token={null}
          onChange={(v) => onChange({ ...draft, threshold: v })}
          onCommit={ready ? onConfirm : undefined}
          unit={thresholdLabel}
          placeholder={pairPrice != null ? formatPythPrice(pairPrice) : "0.00"}
          annotation={(() => {
            if (pairPrice == null || pairPrice <= 0 || draft.threshold == null || draft.threshold <= 0)
              return null;
            const pct = ((draft.threshold - pairPrice) / pairPrice) * 100;
            // Within 0.01% of the live price → render a neutral 0%
            // rather than a noisy ±0.0% / ±0.1% that flickers as the
            // feed ticks. The annotation is meant to give scale, not
            // round-trip the user's typing.
            if (Math.abs(pct) < 0.01) {
              return (
                <span
                  className="hig-footnote"
                  style={{
                    color: "var(--label-tertiary)",
                    fontWeight: 600,
                    fontFeatureSettings: '"tnum"',
                    whiteSpace: "nowrap",
                  }}
                >
                  (0%)
                </span>
              );
            }
            const positive = pct > 0;
            const sign = positive ? "+" : "−";
            const magnitude = Math.abs(pct);
            // Up to 2 decimal places, trailing zeros trimmed:
            //   0.5    → "0.5"
            //   0.55   → "0.55"
            //   0.555  → "0.56"
            //   12     → "12"
            //   1234.5 → "1234.5"
            const formatted = parseFloat(magnitude.toFixed(2)).toString();
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
                ({sign}{formatted}%)
              </span>
            );
          })()}
          presets={
            pairPrice != null
              ? [-15, -5, 5, 15].map((pct) => {
                  const sign = pct > 0 ? "+" : "−";
                  const label = `${sign}${Math.abs(pct)}%`;
                  return {
                    label,
                    apply: (current: number | null) => {
                      const base = current && current > 0 ? current : pairPrice;
                      const raw = base * (1 + pct / 100);
                      const decimals = raw >= 100 ? 0 : raw >= 1 ? 2 : raw >= 0.01 ? 4 : 6;
                      const factor = Math.pow(10, decimals);
                      return Math.round(raw * factor) / factor;
                    },
                  };
                })
              : undefined
          }
        />
        {pairCaption && (
          <div
            className="hig-caption-1"
            style={{
              color: "var(--label-tertiary)",
              fontFeatureSettings: '"tnum"',
              padding: "0.125rem 0.125rem 0",
              display: "flex",
              alignItems: "baseline",
              gap: "0.375rem",
            }}
          >
            <button
              type="button"
              onClick={() => {
                if (pairPrice == null || pairPrice <= 0) return;
                // Snap to the price's natural precision so we don't end
                // up storing a noisy 0.752183... when the user expected
                // 0.7522.
                const decimals =
                  pairPrice >= 100 ? 2 : pairPrice >= 1 ? 4 : pairPrice >= 0.01 ? 6 : 8;
                const factor = Math.pow(10, decimals);
                const rounded = Math.round(pairPrice * factor) / factor;
                onChange({ ...draft, threshold: rounded });
              }}
              title="Use current price"
              style={{
                background: "transparent",
                color: "inherit",
                font: "inherit",
                padding: 0,
                cursor: "pointer",
              }}
            >
              Current: {pairCaption}
            </button>
            <span style={{ color: "var(--label-quaternary)" }}>(Live)</span>
          </div>
        )}
      </FieldRow>

      {statusText && (
        <div
          className="hig-caption-1"
          style={{
            color: "var(--label-tertiary)",
            fontFeatureSettings: '"tnum"',
            padding: "0 0.125rem",
          }}
        >
          {statusText}
        </div>
      )}

      {draft.asset && (
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
          {draft.quote.kind === "usd"
            ? "Quote in another asset"
            : `Quote: ${draft.quote.asset.displaySymbol} — change`}
        </button>
      )}
    </EditorShell>
  );
}
