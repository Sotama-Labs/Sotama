"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { fmt, shortAddress } from "@/lib/format";

export function WalletPill() {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const addr = publicKey?.toBase58() ?? null;
  const { sol } = useWalletBalance(addr);

  const onClick = () => {
    if (connected) disconnect();
    else setVisible(true);
  };

  const baseStyle = {
    display: "flex",
    alignItems: "center",
    gap: "0.625rem",
    padding: "0.4375rem 0.875rem 0.4375rem 0.625rem",
    background: "var(--material-chrome)",
    backdropFilter: "saturate(180%) blur(40px)",
    WebkitBackdropFilter: "saturate(180%) blur(40px)",
    border: "0.5px solid var(--separator)",
    borderRadius: "0.625rem",
    boxShadow: "var(--shadow-1)",
    cursor: "pointer",
    color: "var(--label-primary)",
    fontFamily: "var(--hig-font)",
  } as const;

  if (!connected) {
    return (
      <button
        onClick={onClick}
        aria-label="Connect wallet"
        title={connecting ? "Connecting…" : "Connect a Solana wallet"}
        style={baseStyle}
      >
        <span
          style={{
            width: "0.625rem",
            height: "0.625rem",
            borderRadius: "999px",
            background: "var(--label-tertiary)",
            flexShrink: 0,
          }}
        />
        <span
          className="hig-footnote"
          style={{
            fontWeight: 500,
            color: "var(--label-primary)",
            fontSize: "1rem",
            lineHeight: "1.25rem",
          }}
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </span>
      </button>
    );
  }

  return (
    <button onClick={onClick} aria-label="Disconnect wallet" title={wallet?.adapter.name ?? "Disconnect"} style={baseStyle}>
      <span
        className="pulse-dot"
        style={{
          width: "0.625rem",
          height: "0.625rem",
          borderRadius: "999px",
          background: "var(--green)",
          flexShrink: 0,
        }}
      />
      <span
        className="hig-footnote"
        style={{
          fontFamily: "var(--hig-mono)",
          fontWeight: 500,
          color: "var(--label-primary)",
          fontSize: "1rem",
          lineHeight: "1.25rem",
        }}
      >
        {shortAddress(addr)}
      </span>
      <span className="hig-footnote" style={{ color: "var(--label-tertiary)", fontSize: "1rem", lineHeight: "1.25rem" }}>
        ·
      </span>
      <span className="hig-footnote" style={{ color: "var(--label-secondary)", fontSize: "1rem", lineHeight: "1.25rem" }}>
        {sol == null ? "…" : `${fmt(sol, 2)} SOL`}
      </span>
    </button>
  );
}
