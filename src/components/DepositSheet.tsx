"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import BN from "bn.js";
import type { Action, Trigger } from "@/lib/types";
import { MAX_TIME_ELAPSED_SECS, timeElapsedToSecs } from "@/lib/types";
import { fmt } from "@/lib/format";
import type { BuilderResult } from "./builder/ConditionalBuilder";
import {
  associatedTokenAddress,
  buildCreateAutomationIx,
  buildCreateAutomationSplIx,
  buildCreateAutomationSwapIx,
  cadenceToOnChain,
  getProgram,
  isProgramConfigured,
  fetchConfig,
  parseAutomationCreated,
  SOTAMA_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  type OnChainActionSpec,
  type OnChainTriggerSpec,
} from "@/lib/program";
import { lookupFeedForAsset } from "@/lib/oracles";
import { Spinner } from "./icons";

const SOLANA_NETWORK_FEE_SOL = 0.000045;
const PROTOCOL_FEE_BPS = 20;
const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";
/** Pyth's typical exponent for crypto/USD feeds. Stored at create time so
 *  the keeper knows the threshold's scale; the program currently only
 *  validates that expo ≤ 0 (BadPythExpo). */
const DEFAULT_PYTH_EXPO = -8;

export type OnChainResult = {
  pubkey: string;
  signature: string;
  nonce: string;
};

/** Sum the upfront-deposit amount per token across all actions. */
function depositByToken(actions: Action[]): { totals: Record<string, number> } {
  const totals: Record<string, number> = {};
  for (const a of actions) {
    switch (a.kind) {
      case "transfer":
        totals[a.token.symbol] = (totals[a.token.symbol] || 0) + a.amount;
        break;
      case "swap":
        totals[a.inputToken.symbol] = (totals[a.inputToken.symbol] || 0) + a.amount;
        break;
    }
  }
  return { totals };
}

/** Convert a Pyth feed ID (32-byte hex) to a PublicKey-shaped wrapper.
 *  This is purely a wire-format choice — Pyth pull-oracle feed IDs aren't
 *  Solana accounts, but using a 32-byte field on-chain matches the
 *  Anchor enum schema exactly. The keeper converts back to hex for
 *  Hermes lookups. */
function feedIdToPubkey(feedId: string): PublicKey {
  const hex = feedId.startsWith("0x") ? feedId.slice(2) : feedId;
  return new PublicKey(Buffer.from(hex, "hex"));
}

function tryPubkey(addr: string | null | undefined): PublicKey | null {
  if (!addr) return null;
  try {
    return new PublicKey(addr);
  } catch {
    return null;
  }
}

type SolSpec = {
  kind: "sol";
  trigger: OnChainTriggerSpec;
  action: { transferSol: { destination: PublicKey; amount: BN } };
  amountLamports: bigint;
};
type SplSpec = {
  kind: "spl";
  trigger: OnChainTriggerSpec;
  action: { transferSpl: { destination: PublicKey; mint: PublicKey; amount: BN } };
  destination: PublicKey;
  mint: PublicKey;
  ownerAta: PublicKey;
  destinationAta: PublicKey;
};
type SwapSpec = {
  kind: "swap";
  trigger: OnChainTriggerSpec;
  action: {
    swap: {
      inputMint: PublicKey;
      outputMint: PublicKey;
      destination: PublicKey;
      amountIn: BN;
      minAmountOut: BN;
      linkedDownstream: PublicKey | null;
      linkFeeDeposit: BN;
      consumeUpstreamOutput: boolean;
    };
  };
  inputMint: PublicKey;
  outputMint: PublicKey;
  destination: PublicKey;
  ownerInputAta: PublicKey;
  destinationOutputAta: PublicKey;
};
type OnChainSpec = SolSpec | SplSpec | SwapSpec;

/** Map UI Trigger → on-chain TriggerSpec. Returns null if shape isn't yet
 *  supported on-chain (or has invalid fields). */
async function buildTriggerSpec(t: Trigger): Promise<OnChainTriggerSpec | null> {
  switch (t.kind) {
    case "account_transfer": {
      const account = tryPubkey(t.account);
      if (!account) return null;
      const mint =
        t.token.mode === "specific" && t.token.value
          ? tryPubkey(t.token.value.mint)
          : null;
      return { accountActivity: { account, mint, kind: 0 } };
    }
    case "account_swap": {
      const account = tryPubkey(t.account);
      if (!account) return null;
      const mint =
        t.token.mode === "specific" && t.token.value
          ? tryPubkey(t.token.value.mint)
          : null;
      return { accountActivity: { account, mint, kind: 1 } };
    }
    case "asset_price": {
      // Map OracleSource.kind → on-chain `(feed, source)` pair. The
      // program is oracle-agnostic; the keeper dispatches on `source`.
      // Adding a new oracle = new variant in OracleSource + new keeper
      // watcher + new case here.
      let feed: PublicKey;
      let source: number;
      let defaultExpo: number;
      let inverted = false;
      switch (t.oracle.kind) {
        case "pyth": {
          try {
            feed = feedIdToPubkey(t.oracle.feedId);
          } catch {
            return null;
          }
          source = 0; // oracle_source::PYTH
          defaultExpo = DEFAULT_PYTH_EXPO;
          inverted = t.oracle.inverted === true;
          break;
        }
        case "jupiter": {
          const m = tryPubkey(t.oracle.mint);
          if (!m) return null;
          feed = m;
          source = 1; // oracle_source::JUPITER
          defaultExpo = -6; // Jupiter Price v3 normalizes to USDC scale
          break;
        }
        case "switchboard_pending":
          // Sentinel for assets with no resolved feed. UI should block
          // deploy before reaching this branch; bail to avoid creating
          // a never-firing automation on-chain.
          return null;
      }
      // For inverted Pyth feeds (USD/SGD when the user picked SGD, or
      // EUR/USD when the user picked "USD priced in EUR"), we can't
      // tell the keeper "compare 1/price" without changing the schema.
      // Instead we store an *equivalent* trigger against the actual
      // feed: flip the comparator (above ↔ below) and use the
      // reciprocal of the user's threshold.
      const userIntentComparator = t.comparator === "below" ? 0 : 1;
      const comparator = inverted
        ? userIntentComparator === 0
          ? 1
          : 0
        : userIntentComparator;
      // Decide quote-side wiring based on three orthogonal signals:
      //   • t.quote.kind: did the user pick USD or another asset?
      //   • t.oracle.kind/symbol: did the resolver return a pair feed
      //     (encodes both legs) or just a base/USD feed?
      //   • t.quote.asset.mint: does the quote asset live on Solana?
      //
      // Pair feed (e.g. FX.AUD/JPY, FX.USD/SGD inverted): no quote_mint
      // needed — the keeper just compares the feed against threshold.
      // Token-quote (e.g. BTC priced in USDC): use quote_mint and the
      // keeper resolves the quote via Jupiter probe.
      // Anything else with a non-USD quote isn't deployable yet.
      let quoteMint: PublicKey | null = null;
      let expo: number;
      if (t.quote.kind === "usd") {
        expo = defaultExpo;
      } else {
        // Did the resolver hand us a pair feed? Detect by checking
        // whether the resolved Pyth symbol references the quote ticker
        // anywhere — direct (base/quote) or inverted (quote/base).
        const quoteTicker = t.quote.asset.displaySymbol.toUpperCase();
        const pairResolved =
          t.oracle.kind === "pyth" &&
          (t.oracle.symbol.toUpperCase().includes(`/${quoteTicker}`) ||
            t.oracle.symbol.toUpperCase().includes(`${quoteTicker}/`));
        if (pairResolved) {
          // Feed already encodes the pair; no quote_mint, threshold is
          // in the pair's natural Pyth scale.
          expo = defaultExpo;
        } else if (t.quote.asset.mint) {
          // SPL-mint quote → keeper probes Jupiter for its USD price.
          const m = tryPubkey(t.quote.asset.mint);
          if (!m) return null;
          quoteMint = m;
          expo = -6;
        } else {
          // No SPL mint — fall back to the quote's Pyth feed id. The
          // keeper disambiguates `quote_mint` bytes against the Pyth
          // symbol catalog at fire time (catalog hit → Hermes path,
          // miss → Jupiter probe). 32 bytes either way.
          const quotePyth = await lookupFeedForAsset(t.quote.asset);
          if (!quotePyth) return null;
          try {
            quoteMint = feedIdToPubkey(quotePyth.feedId);
          } catch {
            return null;
          }
          expo = -6;
        }
      }
      // Threshold value to encode: user's number, or its reciprocal if
      // we're targeting an inverted feed. Guard against zero/negative
      // — UI already rejects those, but defence in depth.
      if (inverted && t.threshold <= 0) return null;
      const targetValue = inverted ? 1 / t.threshold : t.threshold;
      const scaled = Math.round(targetValue * Math.pow(10, -expo));
      const threshold = new BN(scaled);
      return {
        assetPrice: { feed, quoteMint, comparator, threshold, expo, source },
      };
    }
    case "time_elapsed": {
      const secs = timeElapsedToSecs(t.value, t.unit);
      if (!(secs > 0) || secs > MAX_TIME_ELAPSED_SECS) return null;
      return { timeElapsed: { durationSecs: secs } };
    }
    case "price_relative_to_fill": {
      // This trigger variant is only valid for linked-chain rules and is
      // built via sendChainCreate in linked-chains.ts (which injects the
      // upstream PDA). Standalone DepositSheet doesn't route here in
      // practice, but must handle the case to satisfy the exhaustive
      // switch. Return null to block accidental standalone submission.
      if (!t.upstream || !(t.pctBps > 0)) return null;
      return {
        priceRelativeToFill: {
          upstream: t.upstream,
          direction: t.direction === "grow" ? 1 : 0,
          pctBps: t.pctBps,
        },
      };
    }
  }
}

/** Map UI Action → on-chain ActionSpec + ix routing kind. */
function buildActionSpec(
  owner: PublicKey,
  a: Action
): { kind: "sol" | "spl" | "swap"; spec: OnChainActionSpec } | null {
  switch (a.kind) {
    case "transfer": {
      const destination = tryPubkey(a.destination);
      if (!destination || !(a.amount > 0)) return null;
      if (a.token.mint === SOL_MINT_STR) {
        return {
          kind: "sol",
          spec: {
            transferSol: {
              destination,
              amount: new BN(Math.round(a.amount * LAMPORTS_PER_SOL)),
            },
          },
        };
      }
      const mint = tryPubkey(a.token.mint);
      if (!mint) return null;
      const baseUnits = Math.round(a.amount * Math.pow(10, a.token.decimals));
      return {
        kind: "spl",
        spec: {
          transferSpl: {
            destination,
            mint,
            amount: new BN(baseUnits),
          },
        },
      };
    }
    case "swap": {
      // Jupiter aggregates across every Solana DEX, so any (input,
      // output) mint pair Jupiter can route is fair game — no pool
      // registry needed at create time. The keeper resolves the
      // actual route at execute time via Jupiter's `/build` API.
      const inputMint = tryPubkey(a.inputToken.mint);
      const outputMint = tryPubkey(a.outputToken.mint);
      if (!inputMint || !outputMint) return null;
      const amountIn = new BN(
        Math.round(a.amount * Math.pow(10, a.inputToken.decimals)),
      );
      // MVP: no create-time quote → min_amount_out = 0. The keeper
      // re-quotes at fire time with the user's desired slippage
      // (default 0.5%) and the on-chain handler enforces the
      // pre/post output-balance delta. A real create-time quote
      // would update this field via Jupiter's /build → outAmount.
      const minAmountOut = new BN(0);
      // Optional linked downstream — when the user wires this swap
      // to feed a downstream automation (auto-deposit pattern).
      const linkedDownstream = a.linkedDownstream
        ? tryPubkey(a.linkedDownstream)
        : null;
      const linkFeeDeposit = new BN(0); // v4 MVP: keeper handles fees via auto-sell
      return {
        kind: "swap",
        spec: {
          swap: {
            inputMint,
            outputMint,
            destination: owner,
            amountIn,
            minAmountOut,
            linkedDownstream,
            linkFeeDeposit,
            consumeUpstreamOutput: false,
          },
        },
      };
    }
  }
}

/** Compose the first-trigger × first-action shape into an OnChainSpec. */
async function getOnChainSpec(
  owner: PublicKey,
  triggers: Trigger[],
  actions: Action[]
): Promise<OnChainSpec | null> {
  if (triggers.length === 0 || actions.length === 0) return null;
  const trigger = await buildTriggerSpec(triggers[0]);
  if (!trigger) return null;
  const action = buildActionSpec(owner, actions[0]);
  if (!action) return null;
  if (action.kind === "sol") {
    const sol = action.spec as { transferSol: { destination: PublicKey; amount: BN } };
    return {
      kind: "sol",
      trigger,
      action: sol,
      amountLamports: BigInt(sol.transferSol.amount.toString()),
    };
  }
  if (action.kind === "spl") {
    const spl = action.spec as {
      transferSpl: { destination: PublicKey; mint: PublicKey; amount: BN };
    };
    return {
      kind: "spl",
      trigger,
      action: spl,
      destination: spl.transferSpl.destination,
      mint: spl.transferSpl.mint,
      ownerAta: associatedTokenAddress(owner, spl.transferSpl.mint),
      destinationAta: associatedTokenAddress(
        spl.transferSpl.destination,
        spl.transferSpl.mint
      ),
    };
  }
  if (action.kind === "swap") {
    const swap = action.spec as {
      swap: {
        inputMint: PublicKey;
        outputMint: PublicKey;
        destination: PublicKey;
        amountIn: BN;
        minAmountOut: BN;
        linkedDownstream: PublicKey | null;
        linkFeeDeposit: BN;
        consumeUpstreamOutput: boolean;
      };
    };
    return {
      kind: "swap",
      trigger,
      action: swap,
      inputMint: swap.swap.inputMint,
      outputMint: swap.swap.outputMint,
      destination: swap.swap.destination,
      ownerInputAta: associatedTokenAddress(owner, swap.swap.inputMint),
      destinationOutputAta: associatedTokenAddress(
        swap.swap.destination,
        swap.swap.outputMint,
      ),
    };
  }
  return null;
}

function FeeRow({ label, sub, value }: { label: string; sub: string; value: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "0.625rem 0.875rem",
        borderBottom: "0.5px solid var(--separator)",
      }}
    >
      <div>
        <div className="hig-subheadline" style={{ color: "var(--label-primary)", fontWeight: 500 }}>
          {label}
        </div>
        <div className="hig-caption-1" style={{ color: "var(--label-secondary)", marginTop: "0.0625rem" }}>
          {sub}
        </div>
      </div>
      <div
        className="hig-subheadline"
        style={{ color: "var(--label-primary)", fontWeight: 500, fontFeatureSettings: '"tnum"' }}
      >
        {value}
      </div>
    </div>
  );
}

export function DepositSheet({
  open,
  automation,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  automation: BuilderResult | null;
  onCancel: () => void;
  /** result is non-null when the tx landed on-chain; null when the rule is
   *  saved locally only (e.g., a not-yet-supported trigger/action combo). */
  onConfirm: (result: OnChainResult | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const { connection } = useConnection();
  const wallet = useWallet();

  const [onChainSpec, setOnChainSpec] = useState<OnChainSpec | null>(null);
  useEffect(() => {
    if (!automation || !wallet.publicKey) {
      setOnChainSpec(null);
      return;
    }
    let alive = true;
    void getOnChainSpec(
      wallet.publicKey,
      automation.triggers,
      automation.actions,
    ).then((spec) => {
      if (alive) setOnChainSpec(spec);
    });
    return () => {
      alive = false;
    };
  }, [automation, wallet.publicKey]);

  useEffect(() => {
    if (!open) return;
    setConfirming(false);
    setErrorMsg(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [open, onCancel]);

  if (!open || !automation) return null;

  const actionsList = automation.actions;
  const { totals } = depositByToken(actionsList);
  const tokens = Object.keys(totals);

  const primaryToken = tokens.sort((a, b) => totals[b] - totals[a])[0] || "—";
  const primaryAmount = totals[primaryToken] || 0;

  const networkFeeSol = SOLANA_NETWORK_FEE_SOL * actionsList.length;
  const protocolFeeByToken: Record<string, number> = {};
  tokens.forEach((t) => {
    protocolFeeByToken[t] = totals[t] * (PROTOCOL_FEE_BPS / 10000);
  });
  const totalByToken: Record<string, number> = {};
  tokens.forEach((t) => {
    totalByToken[t] = totals[t] + protocolFeeByToken[t];
  });

  const handleConfirm = async () => {
    setConfirming(true);
    setErrorMsg(null);

    if (!onChainSpec) {
      await new Promise<void>((resolve) => {
        const id = window.setTimeout(resolve, 250);
        cleanupRef.current = () => window.clearTimeout(id);
      });
      cleanupRef.current = null;
      onConfirm(null);
      return;
    }

    if (!isProgramConfigured() || !SOTAMA_PROGRAM_ID) {
      setErrorMsg("Sotama program ID is not configured. Run `pnpm anchor:deploy:devnet` and update .env.local.");
      setConfirming(false);
      return;
    }
    if (!wallet.connected || !wallet.publicKey) {
      setErrorMsg("Connect a Solana wallet to fund this automation.");
      setConfirming(false);
      return;
    }
    if (!wallet.signTransaction) {
      setErrorMsg("This wallet doesn't support signing.");
      setConfirming(false);
      return;
    }

    try {
      const result = await sendCreateAutomation(
        connection,
        wallet as Parameters<typeof sendCreateAutomation>[1],
        onChainSpec,
        automation.cadence,
        automation.minIntervalSecs,
      );
      onConfirm(result);
    } catch (e) {
      const err = e as Error;
      console.error("create_automation failed", err);
      setErrorMsg(err.message || "Transaction failed. Check console.");
      setConfirming(false);
    }
  };

  const summary = onChainSpec
    ? "Funds release when the trigger fires."
    : "Saved locally — keeper coverage for this rule shape lands in the next release.";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        background: "rgba(0,0,0,0.32)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        animation: "hig-fade-in 200ms cubic-bezier(0.32, 0.72, 0, 1)",
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "23.75rem",
          margin: "1rem",
          background: "var(--bg-system)",
          borderRadius: "var(--radius-sheet)",
          border: "0.5px solid var(--separator)",
          boxShadow: "var(--shadow-popover)",
          overflow: "hidden",
          animation: "hig-pop-in 240ms cubic-bezier(0.32, 0.72, 0, 1)",
        }}
      >
        <div style={{ padding: "1.25rem 1.25rem 1rem", textAlign: "center" }}>
          <div className="hig-headline" style={{ marginBottom: "0.25rem" }}>
            {tokens.length === 0 ? "Activate automation" : "Fund automation"}
          </div>
          <div className="hig-subheadline" style={{ color: "var(--label-secondary)" }}>
            {summary}
          </div>
        </div>

        {tokens.length > 0 && (
          <div style={{ padding: "0.5rem 1.25rem 1.25rem", textAlign: "center" }}>
            <div className="hig-large-title" style={{ color: "var(--label-primary)", fontFeatureSettings: '"tnum"' }}>
              {fmt(primaryAmount, 4)}
              <span className="hig-title-2" style={{ color: "var(--label-secondary)", marginLeft: "0.375rem" }}>
                {primaryToken}
              </span>
            </div>
            {tokens.length > 1 && (
              <div className="hig-footnote" style={{ color: "var(--label-secondary)", marginTop: "0.25rem" }}>
                + {fmt(totals[tokens.find((t) => t !== primaryToken)!], 4)} {tokens.find((t) => t !== primaryToken)}
              </div>
            )}
          </div>
        )}

        <div
          style={{
            margin: "0 1rem 1rem",
            background: "var(--fill-4)",
            border: "0.5px solid var(--separator)",
            borderRadius: "0.625rem",
            overflow: "hidden",
          }}
        >
          {tokens.map((t) => (
            <FeeRow
              key={`dep-${t}`}
              label={tokens.length > 1 ? `Deposit (${t})` : "Deposit"}
              sub="Returned if cancelled"
              value={`${fmt(totals[t], 4)} ${t}`}
            />
          ))}
          {tokens.map((t) => (
            <FeeRow
              key={`fee-${t}`}
              label={tokens.length > 1 ? `Sotama fee (${t})` : "Sotama fee"}
              sub={`${(PROTOCOL_FEE_BPS / 100).toFixed(2)}% of action`}
              value={`${fmt(protocolFeeByToken[t], 4)} ${t}`}
            />
          ))}
          <FeeRow
            label="Network fee"
            sub={
              actionsList.length > 1
                ? `Solana base + priority · ${actionsList.length} actions`
                : "Solana base + priority"
            }
            value={`${networkFeeSol.toFixed(6)} SOL`}
          />
          {tokens.length > 0 ? (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.75rem 0.875rem",
                borderTop: "0.5px solid var(--separator)",
                background: "var(--fill-3)",
              }}
            >
              <span className="hig-headline">Total</span>
              <div style={{ textAlign: "right", fontFeatureSettings: '"tnum"' }}>
                {tokens.map((t) => (
                  <div key={`tot-${t}`} className="hig-headline">
                    {fmt(totalByToken[t], 4)} {t}
                  </div>
                ))}
                <div
                  className="hig-caption-1"
                  style={{ color: "var(--label-secondary)", marginTop: "0.0625rem" }}
                >
                  + {networkFeeSol.toFixed(6)} SOL
                </div>
              </div>
            </div>
          ) : (
            <div
              style={{
                padding: "0.75rem 0.875rem",
                borderTop: "0.5px solid var(--separator)",
                background: "var(--fill-3)",
                textAlign: "center",
              }}
            >
              <span className="hig-footnote" style={{ color: "var(--label-secondary)" }}>
                Network fee paid from your wallet on each execution.
              </span>
            </div>
          )}
        </div>

        {errorMsg && (
          <div
            style={{
              margin: "0 1rem 0.75rem",
              padding: "0.625rem 0.75rem",
              borderRadius: "0.5rem",
              background: "color-mix(in oklab, var(--accent) 8%, transparent)",
              border: "0.5px solid var(--accent)",
            }}
          >
            <div
              className="hig-footnote"
              style={{ color: "var(--label-primary)", textAlign: "center" }}
            >
              {errorMsg}
            </div>
          </div>
        )}

        <div
          className="hig-caption-1"
          style={{
            padding: "0 1.25rem 0.75rem",
            color: "var(--label-tertiary)",
            textAlign: "center",
          }}
        >
          Each rule runs for up to 30 days. Loops keep it going longer as long as the funds keep moving.
        </div>

        <div style={{ display: "flex", borderTop: "0.5px solid var(--separator)" }}>
          <button
            onClick={onCancel}
            disabled={confirming}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 400,
              borderRight: "0.5px solid var(--separator)",
              opacity: confirming ? 0.4 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirming}
            className="hig-body"
            style={{
              flex: 1,
              padding: "0.875rem",
              color: "var(--accent)",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.375rem",
              cursor: confirming ? "wait" : "pointer",
            }}
          >
            {confirming ? (
              <>
                <Spinner /> {onChainSpec ? "Signing…" : "Saving…"}
              </>
            ) : tokens.length === 0 ? (
              onChainSpec ? "Activate" : "Save locally"
            ) : onChainSpec ? (
              "Deposit & Activate"
            ) : (
              "Save locally"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

async function sendCreateAutomation(
  connection: Connection,
  wallet: {
    publicKey: PublicKey | null;
    signTransaction: NonNullable<ReturnType<typeof useWallet>["signTransaction"]>;
    sendTransaction?: ReturnType<typeof useWallet>["sendTransaction"];
  },
  spec: OnChainSpec,
  cadence: import("@/lib/types").Cadence,
  minIntervalSecs: number,
): Promise<OnChainResult> {
  if (!wallet.publicKey) throw new Error("wallet not connected");
  const adapterWallet = {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction,
    signAllTransactions: async <T extends { partialSign: (...s: unknown[]) => void }>(txs: T[]) =>
      Promise.all(txs.map((t) => wallet.signTransaction(t as never))) as unknown as T[],
    payer: undefined as never,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = getProgram(connection, adapterWallet as any);
  const owner = wallet.publicKey;
  // Fetch Config once — needed for the keeper pubkey (time-fee
  // destination) on every create variant + the next nonce.
  const config = await fetchConfig(program);
  const keeper = config.keeper;
  const nonce = BigInt(config.automationCount.toString());

  const tx = new Transaction();
  let automation: PublicKey;
  const onChainCadence = cadenceToOnChain(cadence);

  if (spec.kind === "sol") {
    const built = await buildCreateAutomationIx({
      program,
      owner,
      keeper,
      trigger: spec.trigger,
      action: spec.action,
      cadence: onChainCadence,
      minIntervalSecs,
      nextNonce: nonce,
    });
    tx.add(built.ix);
    automation = built.automation;
  } else if (spec.kind === "spl") {
    // Pre-create the destination ATA (idempotent — no-ops if already
    // exists), the automation PDA's ATA, and the owner's ATA. All
    // three pre-creates are idempotent: they no-op when the ATA
    // exists. The owner's ATA matters because the on-chain
    // `create_automation_spl` handler reads it as a typed
    // `Account<TokenAccount>` and would otherwise revert with
    // "Account does not exist or has no data" before the deposit
    // transfer can run.
    const builtBefore = await buildCreateAutomationSplIx({
      program,
      owner,
      keeper,
      trigger: spec.trigger,
      action: spec.action,
      cadence: onChainCadence,
      minIntervalSecs,
      nextNonce: nonce,
    });
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        spec.ownerAta,
        owner,
        spec.mint,
        SPL_TOKEN_PROGRAM_ID
      )
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        spec.destinationAta,
        spec.destination,
        spec.mint,
        SPL_TOKEN_PROGRAM_ID
      )
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        builtBefore.automationAta,
        builtBefore.automation,
        spec.mint,
        SPL_TOKEN_PROGRAM_ID
      )
    );
    tx.add(builtBefore.ix);
    automation = builtBefore.automation;
  } else if (spec.kind === "swap") {
    // Pre-create the destination wallet's output ATA AND the PDA's
    // input ATA in the same tx, idempotently. The PDA's input ATA is
    // where the deposit lands; the destination's output ATA is where
    // the swap result lands at execute time.
    const builtBefore = await buildCreateAutomationSwapIx({
      program,
      owner,
      keeper,
      trigger: spec.trigger,
      action: spec.action,
      cadence: onChainCadence,
      minIntervalSecs,
      nextNonce: nonce,
    });

    // If the swap input is native SOL, the on-chain create handler
    // expects wrapped-SOL in the owner's input ATA. Auto-wrap by
    // (1) creating the owner's wSOL ATA if missing, (2) transferring
    // the deposit-sized lamports into it, (3) syncNative so the SPL
    // Token program rolls the lamport balance into the token amount.
    // This lets users pick "SOL" in the swap editor without an
    // out-of-band wrap step. The exact wrap amount mirrors the
    // on-chain `total_deposit = amount_in × max_runs` calculation.
    // Always idempotent-create the owner's input ATA so a missing ATA
    // surfaces as a friendlier error. The SOL input branch below also
    // creates this same ATA via NATIVE_MINT (idempotent — no double
    // creation tx for the same address).
    if (spec.inputMint.toBase58() !== SOL_MINT_STR) {
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          spec.ownerInputAta,
          owner,
          spec.inputMint,
          SPL_TOKEN_PROGRAM_ID,
        ),
      );
    }
    if (spec.inputMint.toBase58() === SOL_MINT_STR) {
      const totalFires =
        cadence.kind === "once"
          ? 1
          : cadence.kind === "repeat"
            ? cadence.total
            : 1; // until is rejected on-chain for swap; default to 1
      const amountInLamports = BigInt(spec.action.swap.amountIn.toString());
      const wrapLamports = amountInLamports * BigInt(totalFires);
      const ownerWsolAta = associatedTokenAddress(owner, NATIVE_MINT);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner,
          ownerWsolAta,
          owner,
          NATIVE_MINT,
          SPL_TOKEN_PROGRAM_ID,
        ),
      );
      tx.add(
        SystemProgram.transfer({
          fromPubkey: owner,
          toPubkey: ownerWsolAta,
          lamports: wrapLamports,
        }),
      );
      tx.add(createSyncNativeInstruction(ownerWsolAta, SPL_TOKEN_PROGRAM_ID));
    }

    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        builtBefore.automationInputAta,
        builtBefore.automation,
        spec.inputMint,
        SPL_TOKEN_PROGRAM_ID,
      ),
    );
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        spec.destinationOutputAta,
        spec.destination,
        spec.outputMint,
        SPL_TOKEN_PROGRAM_ID,
      ),
    );
    tx.add(builtBefore.ix);
    automation = builtBefore.automation;
  } else {
    // Exhaustiveness — `spec.kind` is narrowed to `never` here. Throwing
    // keeps `automation` provably-assigned for the type checker.
    throw new Error(`unsupported on-chain spec kind`);
  }

  tx.feePayer = owner;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );

  const txDetails = await connection.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  const logs = txDetails?.meta?.logMessages ?? [];
  const evt = parseAutomationCreated(program, logs);

  return {
    pubkey: evt?.pubkey ?? automation.toBase58(),
    signature: sig,
    nonce: evt?.nonce ?? nonce.toString(),
  };
}
