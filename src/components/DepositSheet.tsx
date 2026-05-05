"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Action, Trigger } from "@/lib/types";
import { fmt } from "@/lib/format";
import type { BuilderResult } from "./builder/ConditionalBuilder";
import {
  buildCreateAutomationIx,
  getProgram,
  isProgramConfigured,
  nextNonce,
  parseAutomationCreated,
  SOTAMA_PROGRAM_ID,
} from "@/lib/program";
import { Spinner } from "./icons";

const SOLANA_NETWORK_FEE_SOL = 0.000045;
const PROTOCOL_FEE_BPS = 20;
const LAMPORTS_PER_SOL = 1_000_000_000;

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

type OnChainSpec = {
  watchedAccount: PublicKey;
  destination: PublicKey;
  amountLamports: bigint;
};

/** MVP scope: only `account_transfer` (any token) → `transfer` (SOL).
 *  Returns null when the rule shape is supported in the UI but not yet
 *  on-chain — caller should save locally and skip the create_automation tx. */
function getOnChainSpec(triggers: Trigger[], actions: Action[]): OnChainSpec | null {
  if (triggers.length === 0 || actions.length === 0) return null;
  const t = triggers[0];
  const a = actions[0];
  if (t.kind !== "account_transfer") return null;
  if (a.kind !== "transfer") return null;
  if (a.token.symbol !== "SOL") return null;
  if (!t.account || !a.destination || !(a.amount > 0)) return null;
  let watched: PublicKey;
  let dest: PublicKey;
  try {
    watched = new PublicKey(t.account);
    dest = new PublicKey(a.destination);
  } catch {
    return null;
  }
  return {
    watchedAccount: watched,
    destination: dest,
    amountLamports: BigInt(Math.round(a.amount * LAMPORTS_PER_SOL)),
  };
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
   *  saved locally only (e.g., a staking automation with no upfront deposit
   *  or a not-yet-supported trigger/action combo). */
  onConfirm: (result: OnChainResult | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const { connection } = useConnection();
  const wallet = useWallet();

  const onChainSpec = useMemo(
    () => (automation ? getOnChainSpec(automation.triggers, automation.actions) : null),
    [automation]
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

    // Path A — no on-chain deposit needed (staking-only or unsupported MVP rule).
    if (!onChainSpec) {
      // Brief delay so the spinner reads as "doing something."
      await new Promise<void>((resolve) => {
        const id = window.setTimeout(resolve, 250);
        cleanupRef.current = () => window.clearTimeout(id);
      });
      cleanupRef.current = null;
      onConfirm(null);
      return;
    }

    // Path B — funded SOL automation. Build, sign, send `create_automation`.
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
            {tokens.length === 0
              ? "Funded by staking rewards. No upfront deposit needed."
              : onChainSpec
              ? "Funds release when the trigger fires."
              : "Saved locally — keeper coverage for this rule shape lands in the next release."}
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
              "Activate"
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

/** Build, sign, send, confirm a `create_automation` tx and parse the
 *  emitted Automation pubkey + nonce out of the logs. */
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
  // AnchorProvider expects a `Wallet` shape with .signAllTransactions; the
  // wallet adapter exposes that in `useWallet().signAllTransactions`. Build a
  // minimal Wallet shim so we can use Program.methods.
  const adapterWallet = {
    publicKey: wallet.publicKey,
    signTransaction: wallet.signTransaction,
    signAllTransactions: async <T extends { partialSign: (...s: unknown[]) => void }>(txs: T[]) =>
      Promise.all(txs.map((t) => wallet.signTransaction(t as never))) as unknown as T[],
    payer: undefined as never, // unused by Program when only building/signing client-side
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = getProgram(connection, adapterWallet as any);

  const nonce = await nextNonce(program);
  const { ix, automation } = await buildCreateAutomationIx({
    program,
    owner: wallet.publicKey,
    watchedAccount: spec.watchedAccount,
    destination: spec.destination,
    amountLamports: spec.amountLamports,
    nextNonce: nonce,
  });

  const { Transaction } = await import("@solana/web3.js");
  const tx = new Transaction().add(ix);
  tx.feePayer = wallet.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

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
