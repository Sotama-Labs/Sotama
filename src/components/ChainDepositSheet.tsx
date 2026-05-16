"use client";

/* ─────────────────────────────────────────────────────────────────────
   Chain-mode deposit sheet. Mirrors DepositSheet's UX (modal, fee row
   list, single confirm button) but sends the atomic multi-create
   transaction that provisions every rule in a linked chain in one shot.
   ───────────────────────────────────────────────────────────────────── */

import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Transaction } from "@solana/web3.js";
import { fmt } from "@/lib/format";
import {
  sendChainCreate,
  summarizeChain,
  type ChainCreateResult,
  type ChainNodeDraft,
} from "@/lib/linked-chains";
import type { LoopMode } from "@/lib/types";
import { Spinner } from "./icons";

export type ChainOnChainResult = {
  signature: string;
  nodes: Array<{ pubkey: string; nonce: string; seedAmount: string }>;
};

// Protocol swap fee disabled: `Config.swap_fee_bps` set to 0 on-chain
// until the fee-collection path is redesigned. No fee preview is shown.

export function ChainDepositSheet({
  open,
  nodes,
  loopMode,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  nodes: ChainNodeDraft[] | null;
  loopMode: LoopMode | null;
  onCancel: () => void;
  onConfirm: (result: ChainOnChainResult | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const { connection } = useConnection();
  const wallet = useWallet();

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

  if (!open || !nodes) return null;

  const summary = summarizeChain(nodes, loopMode);
  const totalsByToken = summary.totalsByToken;
  const tokens = Object.keys(totalsByToken);
  const primaryToken = tokens.sort((a, b) => totalsByToken[b] - totalsByToken[a])[0] || "—";
  const primaryAmount = totalsByToken[primaryToken] || 0;

  // Protocol swap fee disabled — totals are just the seed deposit.
  const totalByToken: Record<string, number> = { ...totalsByToken };

  const handleConfirm = async () => {
    setConfirming(true);
    setErrorMsg(null);

    if (!wallet.connected || !wallet.publicKey) {
      setErrorMsg("Connect a Solana wallet to fund this chain.");
      setConfirming(false);
      return;
    }
    if (!wallet.signTransaction) {
      setErrorMsg("This wallet doesn't support signing.");
      setConfirming(false);
      return;
    }

    try {
      const owner = wallet.publicKey;
      const signTx = wallet.signTransaction;
      const signAll = wallet.signAllTransactions;
      const result: ChainCreateResult = await sendChainCreate({
        connection,
        wallet: {
          publicKey: owner,
          signTransaction: <T extends Transaction>(tx: T) => signTx(tx),
          signAllTransactions: signAll
            ? <T extends Transaction>(txs: T[]) => signAll(txs)
            : undefined,
        },
        nodes,
        loopMode,
      });
      onConfirm({ signature: result.signature, nodes: result.nodes });
    } catch (e) {
      const err = e as Error;
      console.error("chain create failed", err);
      setErrorMsg(err.message || "Chain transaction failed. Check console.");
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
          maxWidth: "26rem",
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
            {nodes.length === 1 && loopMode
              ? "Fund self-loop rule"
              : loopMode
                ? `Fund ${nodes.length}-rule loop`
                : `Fund ${nodes.length}-rule chain`}
          </div>
          <div className="hig-subheadline" style={{ color: "var(--label-secondary)" }}>
            {nodes.length === 1 && loopMode?.kind === "frequency"
              ? `Rule fires ${loopMode.cycles} times. The deposit covers all cycles.`
              : nodes.length === 1 && loopMode?.kind === "infinite"
                ? "Rule keeps firing until the deposit runs out."
                : loopMode
                  ? "Created in one transaction. Only the first rule is funded upfront; the loop funds the rest."
                  : "Created in one transaction. Only the first rule is funded upfront; later rules pick up funding from the previous rule's swap."}
          </div>
        </div>

        <div style={{ padding: "0.5rem 1.25rem 1rem", textAlign: "center" }}>
          <div
            className="hig-large-title"
            style={{ color: "var(--label-primary)", fontFeatureSettings: '"tnum"' }}
          >
            {fmt(primaryAmount, 4)}
            <span
              className="hig-title-2"
              style={{ color: "var(--label-secondary)", marginLeft: "0.375rem" }}
            >
              {primaryToken}
            </span>
          </div>
          {tokens.length > 1 && (
            <div
              className="hig-footnote"
              style={{ color: "var(--label-secondary)", marginTop: "0.25rem" }}
            >
              + {fmt(
                totalsByToken[tokens.find((t) => t !== primaryToken)!],
                4,
              )} {tokens.find((t) => t !== primaryToken)}
            </div>
          )}
        </div>

        <div
          style={{
            margin: "0 1rem 0.875rem",
            background: "var(--fill-4)",
            border: "0.5px solid var(--separator)",
            borderRadius: "0.625rem",
            overflow: "hidden",
          }}
        >
          {summary.nodes.map((node, i) => (
            <div
              key={i}
              style={{
                padding: "0.625rem 0.875rem",
                borderBottom:
                  i === summary.nodes.length - 1
                    ? "none"
                    : "0.5px solid var(--separator)",
                display: "flex",
                alignItems: "flex-start",
                gap: "0.625rem",
              }}
            >
              <span
                className="hig-caption-1"
                style={{
                  width: "1.5rem",
                  height: "1.5rem",
                  borderRadius: "999px",
                  background: node.isHead ? "var(--accent-fill)" : "var(--fill-3)",
                  color: node.isHead ? "var(--accent)" : "var(--label-secondary)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 600,
                  flexShrink: 0,
                  marginTop: "0.0625rem",
                }}
              >
                {i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  className="hig-subheadline"
                  style={{ color: "var(--label-primary)", fontWeight: 500 }}
                >
                  {node.actionSummary}
                </div>
                <div
                  className="hig-caption-1"
                  style={{
                    color: "var(--label-secondary)",
                    marginTop: "0.0625rem",
                  }}
                >
                  when {node.triggerSummary} · {node.linkSummary}
                </div>
                {node.isHead && (
                  <div
                    className="hig-caption-1"
                    style={{
                      color: "var(--accent)",
                      marginTop: "0.125rem",
                      fontWeight: 500,
                    }}
                  >
                    Seed: {fmt(node.seedAmount, 4)} {node.seedToken}
                  </div>
                )}
                {!node.isHead && (
                  <div
                    className="hig-caption-1"
                    style={{
                      color: "var(--label-tertiary)",
                      marginTop: "0.125rem",
                    }}
                  >
                    Funded by the previous rule's swap
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div
          style={{
            margin: "0 1rem 1rem",
            background: "var(--fill-4)",
            border: "0.5px solid var(--separator)",
            borderRadius: "0.625rem",
            overflow: "hidden",
          }}
        >
          <FeeRow
            label="Network fee"
            sub={`Solana base + priority · ${nodes.length} create ix${nodes.length === 1 ? "" : "s"}`}
            value={`${fmt(summary.networkFeeSol, 6)} SOL`}
          />
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
                + {fmt(summary.networkFeeSol, 6)} SOL
              </div>
            </div>
          </div>
        </div>

        {errorMsg && (
          <div
            style={{
              margin: "0 1rem 0.75rem",
              padding: "0.625rem 0.75rem",
              borderRadius: "0.5rem",
              background: "color-mix(in oklab, var(--red) 8%, transparent)",
              border: "0.5px solid var(--red)",
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
                <Spinner /> Signing chain…
              </>
            ) : (
              "Deposit & Run Chain"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function FeeRow({
  label,
  sub,
  value,
}: {
  label: string;
  sub: string;
  value: string;
}) {
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
        <div
          className="hig-subheadline"
          style={{ color: "var(--label-primary)", fontWeight: 500 }}
        >
          {label}
        </div>
        <div
          className="hig-caption-1"
          style={{ color: "var(--label-secondary)", marginTop: "0.0625rem" }}
        >
          {sub}
        </div>
      </div>
      <div
        className="hig-subheadline"
        style={{
          color: "var(--label-primary)",
          fontWeight: 500,
          fontFeatureSettings: '"tnum"',
        }}
      >
        {value}
      </div>
    </div>
  );
}
