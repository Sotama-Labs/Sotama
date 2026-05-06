"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import BN from "bn.js";
import type { Action, Trigger } from "@/lib/types";
import { fmt } from "@/lib/format";
import type { BuilderResult } from "./builder/ConditionalBuilder";
import {
  associatedTokenAddress,
  buildCreateAutomationIx,
  buildCreateAutomationSplIx,
  buildCreateAutomationStakeIx,
  getProgram,
  isProgramConfigured,
  nextNonce,
  parseAutomationCreated,
  SOTAMA_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  type OnChainActionSpec,
  type OnChainTriggerSpec,
} from "@/lib/program";
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
function depositByToken(actions: Action[]): { totals: Record<string, number>; staking: boolean } {
  const totals: Record<string, number> = {};
  let staking = false;
  for (const a of actions) {
    switch (a.kind) {
      case "transfer":
        totals[a.token.symbol] = (totals[a.token.symbol] || 0) + a.amount;
        break;
      case "swap":
        totals[a.inputToken.symbol] = (totals[a.inputToken.symbol] || 0) + a.amount;
        break;
      case "restake":
      case "sell_for":
      case "transfer_reward":
        staking = true;
        break;
    }
  }
  return { totals, staking };
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
type StakeSpec = {
  kind: "stake";
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec;
};
type OnChainSpec = SolSpec | SplSpec | StakeSpec;

/** Map UI Trigger → on-chain TriggerSpec. Returns null if shape isn't yet
 *  supported on-chain (or has invalid fields). */
function buildTriggerSpec(t: Trigger): OnChainTriggerSpec | null {
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
    case "token_price": {
      if (t.oracle.kind !== "pyth") return null;
      const feed = (() => {
        try {
          return feedIdToPubkey(t.oracle.feedId);
        } catch {
          return null;
        }
      })();
      if (!feed) return null;
      const comparator = t.comparator === "below" ? 0 : 1;
      const expo = DEFAULT_PYTH_EXPO;
      const scaled = Math.round(t.threshold * Math.pow(10, -expo));
      const threshold = new BN(scaled);
      return { tokenPrice: { feed, comparator, threshold, expo } };
    }
    case "staking_reward_amount": {
      const stake = tryPubkey(t.stakeAccount);
      if (!stake) return null;
      const value = new BN(Math.round(t.threshold * LAMPORTS_PER_SOL));
      return { stakingReward: { stakeAccount: stake, mode: 0, value } };
    }
    case "staking_reward_time": {
      const stake = tryPubkey(t.stakeAccount);
      if (!stake) return null;
      const value = new BN(t.intervalDays * 86_400);
      return { stakingReward: { stakeAccount: stake, mode: 1, value } };
    }
  }
}

/** Map UI Action → on-chain ActionSpec + ix routing kind. Returns null
 *  for unsupported (Jupiter swap / sell_for). */
function buildActionSpec(
  owner: PublicKey,
  a: Action
): { kind: "sol" | "spl" | "stake"; spec: OnChainActionSpec } | null {
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
    case "swap":
    case "sell_for":
      return null;
    case "restake": {
      const stake = tryPubkey(a.stakeAccount);
      const vote = tryPubkey(a.voteAccount);
      if (!stake || !vote) return null;
      return {
        kind: "stake",
        spec: { stakeRestake: { stakeAccount: stake, voteAccount: vote } },
      };
    }
    case "transfer_reward": {
      const stake = tryPubkey(a.stakeAccount);
      const destination = tryPubkey(a.destination);
      if (!stake || !destination) return null;
      return {
        kind: "stake",
        spec: { stakeWithdrawReward: { stakeAccount: stake, destination } },
      };
    }
  }
  // exhaustiveness
  return null;
}

/** Compose the first-trigger × first-action shape into an OnChainSpec. */
function getOnChainSpec(
  owner: PublicKey,
  triggers: Trigger[],
  actions: Action[]
): OnChainSpec | null {
  if (triggers.length === 0 || actions.length === 0) return null;
  const trigger = buildTriggerSpec(triggers[0]);
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
  return { kind: "stake", trigger, action: action.spec };
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

  const onChainSpec = useMemo(
    () =>
      automation && wallet.publicKey
        ? getOnChainSpec(wallet.publicKey, automation.triggers, automation.actions)
        : null,
    [automation, wallet.publicKey]
  );

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
  const { totals, staking } = depositByToken(actionsList);
  const tokens = Object.keys(totals);

  const primaryToken = tokens.sort((a, b) => totals[b] - totals[a])[0] || (staking ? "SOL" : "—");
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
        onChainSpec
      );
      onConfirm(result);
    } catch (e) {
      const err = e as Error;
      console.error("create_automation failed", err);
      setErrorMsg(err.message || "Transaction failed. Check console.");
      setConfirming(false);
    }
  };

  const summary =
    tokens.length === 0
      ? "Funded by staking rewards. No upfront deposit needed."
      : onChainSpec
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
  spec: OnChainSpec
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
  const nonce = await nextNonce(program);

  const tx = new Transaction();
  let automation: PublicKey;

  if (spec.kind === "sol") {
    const built = await buildCreateAutomationIx({
      program,
      owner,
      trigger: spec.trigger,
      action: spec.action,
      nextNonce: nonce,
    });
    tx.add(built.ix);
    automation = built.automation;
  } else if (spec.kind === "spl") {
    // Pre-create the destination ATA (idempotent — no-ops if already exists)
    // and the automation PDA's ATA. Both are paid by the owner.
    const builtBefore = await buildCreateAutomationSplIx({
      program,
      owner,
      trigger: spec.trigger,
      action: spec.action,
      nextNonce: nonce,
    });
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
  } else {
    const built = await buildCreateAutomationStakeIx({
      program,
      owner,
      trigger: spec.trigger,
      action: spec.action,
      nextNonce: nonce,
    });
    tx.add(built.ix);
    automation = built.automation;
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
