"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { Check } from "../icons";
import { AddressInput } from "./AddressInput";

/* ─────────────────────────────────────────────────────────────────────
   Address input + "Use my wallet" toggle for the Track Account triggers.
   The toggle is on when the field's value matches the connected wallet's
   public key, and clicking it auto-fills (or clears, if already on).
   ───────────────────────────────────────────────────────────────────── */

export function AccountAddressInput({
  value,
  onChange,
  onCommit,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  onCommit?: () => void;
}) {
  const { publicKey } = useWallet();
  const myAddress = publicKey?.toBase58() ?? null;
  const isMine = !!myAddress && value === myAddress;

  const toggleMine = () => {
    if (!myAddress) return;
    onChange(isMine ? null : myAddress);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
      <button
        onClick={toggleMine}
        disabled={!myAddress}
        aria-pressed={isMine}
        className="hig-caption-1"
        style={{
          alignSelf: "flex-start",
          display: "inline-flex",
          alignItems: "center",
          gap: "0.375rem",
          padding: "0.1875rem 0.5rem 0.1875rem 0.375rem",
          borderRadius: "999px",
          background: isMine ? "var(--accent-fill)" : "var(--fill-3)",
          color: isMine ? "var(--accent)" : "var(--label-secondary)",
          fontWeight: 500,
          opacity: myAddress ? 1 : 0.5,
          cursor: myAddress ? "pointer" : "not-allowed",
          transition: "background 120ms, color 120ms",
        }}
      >
        <span
          aria-hidden
          style={{
            width: "0.875rem",
            height: "0.875rem",
            borderRadius: "50%",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: isMine ? "var(--accent)" : "transparent",
            border: isMine ? "none" : "1px solid var(--label-tertiary)",
            color: "white",
            transition: "background 120ms, border-color 120ms",
          }}
        >
          {isMine && <Check size={9} strokeWidth={2.4} />}
        </span>
        {myAddress ? "Use my wallet" : "Connect wallet to auto-fill"}
      </button>
      <AddressInput value={value} onChange={onChange} onCommit={onCommit} />
    </div>
  );
}
