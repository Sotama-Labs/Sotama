"use client";

import { useState } from "react";
import type { ChainLinkClass, DraftSwap } from "@/lib/types";
import { TokenPicker } from "../TokenPicker";
import { TokenPill } from "../TokenPill";
import { AmountInput } from "../AmountInput";
import { EditorShell, FieldRow } from "../EditorShell";

type Picking = "input" | "output" | null;

const WSOL_MINT = "So11111111111111111111111111111111111111112";
// Jupiter v6 `route_v2` bundles a setup ix that creates a temporary
// program-owned wSOL account and a cleanup ix that unwraps it to the
// PDA. Our `execute_swap` only CPI-relays the swap ix, so the temp
// account never exists and Jupiter rejects with 6025 InvalidTokenAccount.
// Until execute_swap is upgraded to relay setup + cleanup (and the
// destination accounting is reworked for native-SOL output), block wSOL
// as a swap destination at the UI layer.
const OUTPUT_WSOL_BLOCKED =
  "Swapping into SOL isn't supported yet — Jupiter's native-SOL path needs setup/cleanup steps the on-chain program doesn't relay. Pick any SPL token (USDC, USDT, JUP, BONK, …) instead.";
const blockOutputMint = (mint: string): string | null =>
  mint === WSOL_MINT ? OUTPUT_WSOL_BLOCKED : null;

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
  const outputBlockedReason = draft.outputToken
    ? blockOutputMint(draft.outputToken.mint)
    : null;
  const ready =
    draft.inputToken != null &&
    draft.outputToken != null &&
    outputBlockedReason == null &&
    (draft.consumeUpstreamOutput === true ||
      (draft.amount != null && draft.amount > 0));

  if (picking === "input") {
    return (
      <TokenPicker
        title="Swap from"
        selected={draft.inputToken}
        exclude={draft.outputToken}
        onBack={() => setPicking(null)}
        onSelect={(token) => {
          onChange({ ...draft, inputToken: token });
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
        exclude={draft.inputToken}
        blocked={blockOutputMint}
        onBack={() => setPicking(null)}
        onSelect={(token) => {
          onChange({ ...draft, outputToken: token });
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

      {outputBlockedReason != null && (
        <div
          className="hig-caption-1"
          style={{
            padding: "0.5rem 0.75rem",
            margin: "-0.25rem 0 0.25rem",
            borderRadius: "0.5rem",
            background: "color-mix(in oklab, var(--orange) 12%, transparent)",
            border: "0.5px solid color-mix(in oklab, var(--orange) 32%, transparent)",
            color: "var(--label-primary)",
            lineHeight: 1.4,
          }}
        >
          {outputBlockedReason}
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
