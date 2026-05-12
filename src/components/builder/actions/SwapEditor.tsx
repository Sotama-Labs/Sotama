"use client";

import { useState } from "react";
import type { ChainLinkClass, DraftSwap } from "@/lib/types";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

type Picking = "input" | "output" | null;

const WSOL_MINT = "So11111111111111111111111111111111111111112";
// SOL output is supported via wrapped SOL: the keeper passes
// `wrapAndUnwrapSol=false` + `destinationTokenAccount=<dest's wSOL ATA>`
// to Jupiter, so Jupiter writes directly to the destination's wSOL ATA
// without needing the temp-account + cleanup-unwrap flow that
// execute_swap doesn't relay. The destination wallet sees the result
// as a Wrapped SOL balance with a one-click "Unwrap to SOL" in Phantom
// / Backpack / Solflare. We surface this as a soft INFO note (not a
// block) at picker time so users aren't surprised.
const OUTPUT_WSOL_INFO =
  "You'll receive wrapped SOL (wSOL). Your wallet shows it as 'Wrapped SOL' with a one-click unwrap to native SOL.";

export function SwapEditor({
  draft,
  onChange,
  onBack,
  onConfirm,
  linkClassUpstream,
}: {
  draft: DraftSwap;
  onChange: (next: DraftSwap) => void;
  onBack: () => void;
  onConfirm: () => void;
  linkClassUpstream?: ChainLinkClass;
}) {
  const [picking, setPicking] = useState<Picking>(null);

  // Hooks must run in the same order every render — keep them above
  // any conditional return.
  // Info note (not a block) shown when the output is wSOL — explains
  // that the deliverable is wrapped SOL, with one-click unwrap in any
  // modern Solana wallet. Doesn't gate `ready`.
  const outputIsWsol = draft.outputToken?.mint === WSOL_MINT;
  const ready =
    draft.inputToken != null &&
    draft.outputToken != null &&
    (draft.consumeUpstreamOutput === true ||
      (draft.amount != null && draft.amount > 0));

  if (picking === "input") {
    return (
      <TokenPicker
        title="Swap from"
        selected={draft.inputToken}
        onBack={() => setPicking(null)}
        onSelect={(token) => {
          // If the user picked the same token as the current output,
          // the swap would be in→in (no-op). Clear output so they can
          // pick a different counter-token in the next step. Better
          // than hiding it from the list — the user clearly wants this
          // token as input and we shouldn't force a re-pick on the
          // other side just to free it up.
          const collides =
            draft.outputToken != null &&
            draft.outputToken.mint === token.mint;
          onChange({
            ...draft,
            inputToken: token,
            outputToken: collides ? null : draft.outputToken,
          });
          setPicking(null);
        }}
      />
    );
  }
  if (picking === "output") {
    return (
      <TokenPicker
        title="Swap to"
        selected={draft.outputToken}
        onBack={() => setPicking(null)}
        onSelect={(token) => {
          const collides =
            draft.inputToken != null &&
            draft.inputToken.mint === token.mint;
          onChange({
            ...draft,
            outputToken: token,
            inputToken: collides ? null : draft.inputToken,
          });
          setPicking(null);
        }}
      />
    );
  }

  return (
    <EditorShell title="Swap" side="then" onBack={onBack} onConfirm={onConfirm} ready={ready}>
      <FieldRow label="From">
        <button
          onClick={() => setPicking("input")}
          style={pickerBtn}
        >
          {draft.inputToken ? (
            <TokenPill token={draft.inputToken} />
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick input token…
            </span>
          )}
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            change
          </span>
        </button>
      </FieldRow>

      <FieldRow label="To">
        <button
          onClick={() => setPicking("output")}
          style={pickerBtn}
        >
          {draft.outputToken ? (
            <TokenPill token={draft.outputToken} />
          ) : (
            <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
              Pick output token…
            </span>
          )}
          <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
            change
          </span>
        </button>
      </FieldRow>

      {outputIsWsol && (
        <div
          className="hig-caption-1"
          style={{
            padding: "0.5rem 0.75rem",
            margin: "-0.25rem 0 0.25rem",
            borderRadius: "0.5rem",
            background: "color-mix(in oklab, var(--accent) 10%, transparent)",
            border: "0.5px solid color-mix(in oklab, var(--accent) 28%, transparent)",
            color: "var(--label-primary)",
            lineHeight: 1.4,
          }}
        >
          {OUTPUT_WSOL_INFO}
        </div>
      )}

      {linkClassUpstream != null && (
        <button
          type="button"
          onClick={() => {
            const nextConsume = !draft.consumeUpstreamOutput;
            onChange({
              ...draft,
              consumeUpstreamOutput: nextConsume,
              // Default amount to 0 when turning consume ON so the
              // frozen SwapAction.amount stays a `number` (the on-chain
              // amount_in is overridden to u64::MAX in this case
              // anyway — see linked-chains.ts:buildSwapAction).
              amount: nextConsume && draft.amount == null ? 0 : draft.amount,
            });
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.375rem",
            padding: "0.25rem 0.625rem",
            borderRadius: "999px",
            background: draft.consumeUpstreamOutput ? "var(--accent-fill)" : "var(--fill-3)",
            color: draft.consumeUpstreamOutput ? "var(--accent)" : "var(--label-secondary)",
            fontSize: "0.875rem",
            fontWeight: 500,
            border: "0.5px solid var(--separator)",
            cursor: "pointer",
            alignSelf: "flex-start",
          }}
          title={
            draft.consumeUpstreamOutput
              ? "Will swap whatever the upstream rule produced"
              : "Use a fixed input amount per fire"
          }
        >
          {draft.consumeUpstreamOutput ? "✓ Use upstream output" : "Use upstream output"}
        </button>
      )}

      <FieldRow label={`Amount (${draft.inputToken?.symbol ?? "input"})`}>
        {draft.consumeUpstreamOutput ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0.5rem 0.75rem",
              background: "var(--fill-4)",
              border: "0.5px solid var(--separator)",
              borderRadius: "0.5rem",
              opacity: 0.6,
            }}
          >
            <span
              className="hig-body"
              style={{ color: "var(--label-secondary)", fontWeight: 500 }}
            >
              = upstream output
            </span>
          </div>
        ) : (
          <AmountInput
            value={draft.amount}
            token={draft.inputToken}
            unit={draft.inputToken?.symbol}
            onChange={(v) => onChange({ ...draft, amount: v })}
            onCommit={ready ? onConfirm : undefined}
          />
        )}
      </FieldRow>

      <div
        className="hig-caption-1"
        style={{ color: "var(--label-secondary)", padding: "0.25rem 0.125rem" }}
      >
        Routed through Jupiter at execute time — best price across every
        Solana DEX. The keeper re-quotes on each fire and respects your
        slippage tolerance (default 0.5%).
      </div>
    </EditorShell>
  );
}

const pickerBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.5rem 0.625rem",
  background: "var(--fill-4)",
  border: "0.5px solid var(--separator)",
  borderRadius: "0.5rem",
};
