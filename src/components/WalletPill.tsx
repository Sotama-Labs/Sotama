"use client";

import { useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { fmt, shortAddress } from "@/lib/format";
import { Popover } from "./builder/Popover";
import { Chevron } from "./icons";

export function WalletPill() {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const addr = publicKey?.toBase58() ?? null;
  const { sol } = useWalletBalance(addr);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [disconnectHover, setDisconnectHover] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  if (!connected) {
    return (
      <button
        onClick={() => setVisible(true)}
        aria-label="Connect wallet"
        title={connecting ? "Connecting…" : "Connect a Solana wallet"}
        style={{
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
        }}
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

  const active = hover || open;

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        aria-label="Wallet menu"
        aria-expanded={open}
        aria-haspopup="menu"
        title={wallet?.adapter.name ?? "Wallet"}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.625rem",
          padding: "0.4375rem 0.875rem 0.4375rem 0.625rem",
          background: active ? "var(--material-chrome)" : "transparent",
          backdropFilter: active ? "saturate(180%) blur(40px)" : "none",
          WebkitBackdropFilter: active ? "saturate(180%) blur(40px)" : "none",
          border: "0.5px solid",
          borderColor: active ? "var(--separator)" : "transparent",
          borderRadius: "0.625rem",
          boxShadow: active ? "var(--shadow-1)" : "none",
          cursor: "pointer",
          color: "var(--label-primary)",
          fontFamily: "var(--hig-font)",
          transition: "background 160ms ease, border-color 160ms ease, box-shadow 160ms ease",
        }}
      >
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
        <span
          style={{
            display: "inline-flex",
            color: "var(--label-tertiary)",
            marginLeft: "0.125rem",
            opacity: active ? 1 : 0,
            transition: "opacity 160ms ease",
          }}
        >
          <Chevron size={9} dir={open ? "up" : "down"} />
        </span>
      </button>

      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} width={264}>
        <div style={{ padding: "0.75rem 0.875rem 0.5rem" }}>
          <div
            className="hig-caption-2"
            style={{
              color: "var(--label-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              fontSize: "0.6875rem",
              lineHeight: "0.875rem",
              marginBottom: "0.25rem",
            }}
          >
            {wallet?.adapter.name ?? "Wallet"}
          </div>
          <div
            style={{
              fontFamily: "var(--hig-mono)",
              fontSize: "0.8125rem",
              lineHeight: "1.125rem",
              color: "var(--label-primary)",
              wordBreak: "break-all",
            }}
          >
            {addr}
          </div>
        </div>

        <div style={{ height: "0.5px", background: "var(--separator)" }} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.5rem 0.875rem",
          }}
        >
          <span className="hig-footnote" style={{ color: "var(--label-secondary)", fontSize: "0.875rem", lineHeight: "1.25rem" }}>
            Balance
          </span>
          <span
            className="hig-footnote"
            style={{
              fontFamily: "var(--hig-mono)",
              fontWeight: 500,
              color: "var(--label-primary)",
              fontSize: "0.875rem",
              lineHeight: "1.25rem",
            }}
          >
            {sol == null ? "…" : `${fmt(sol, 4)} SOL`}
          </span>
        </div>

        <div style={{ height: "0.5px", background: "var(--separator)" }} />

        <button
          onClick={() => {
            setOpen(false);
            disconnect();
          }}
          onMouseEnter={() => setDisconnectHover(true)}
          onMouseLeave={() => setDisconnectHover(false)}
          className="hig-body"
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            padding: "0.5rem 0.875rem",
            background: disconnectHover ? "var(--red)" : "transparent",
            color: disconnectHover ? "white" : "var(--red)",
            textAlign: "left",
            fontSize: "0.875rem",
            lineHeight: "1.25rem",
            transition: "background 60ms",
            border: "none",
            cursor: "pointer",
          }}
        >
          Disconnect
        </button>
      </Popover>
    </>
  );
}
