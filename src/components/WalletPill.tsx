"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useWalletBalance } from "@/hooks/useWalletBalance";
import { useSolPrice } from "@/hooks/useSolPrice";
import { fmt, shortAddress } from "@/lib/format";
import { CLUSTER } from "@/lib/rpc";
import { Popover } from "./builder/Popover";
import { Check, Chevron } from "./icons";

function CopyGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <rect x="3.25" y="3.25" width="7.5" height="7.5" rx="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M5.25 3.25 V2.4 a1 1 0 0 1 1-1 H10.6 a1 1 0 0 1 1 1 V8.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

const CLUSTER_LABEL: Record<string, string> = {
  "mainnet-beta": "Mainnet",
  devnet: "Devnet",
};

export function WalletPill() {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const addr = publicKey?.toBase58() ?? null;
  const { sol } = useWalletBalance(addr);
  const { price } = useSolPrice();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [disconnectHover, setDisconnectHover] = useState(false);
  const [addrHover, setAddrHover] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<number | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
    };
  }, []);

  const onCopy = async () => {
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      if (copyTimeoutRef.current) window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; quietly noop
    }
  };

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
  const usd = sol != null && price != null ? sol * price : null;
  const clusterLabel = CLUSTER_LABEL[CLUSTER] ?? CLUSTER;
  const isDevnet = CLUSTER === "devnet";
  const clusterAccent = isDevnet ? "var(--orange)" : "var(--green)";
  const walletIcon = wallet?.adapter.icon;
  const walletName = wallet?.adapter.name ?? "Wallet";

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
        title={walletName}
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

      <Popover anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} width={296}>
        {/* Hero — balance */}
        <div style={{ padding: "1.25rem 1.25rem 1.125rem" }}>
          <div
            className="hig-title-2"
            style={{
              fontFamily: "var(--hig-font-display)",
              color: "var(--label-primary)",
              fontVariantNumeric: "tabular-nums",
              display: "flex",
              alignItems: "baseline",
              gap: "0.375rem",
            }}
          >
            <span>{sol == null ? "—" : fmt(sol, 2)}</span>
            <span style={{ color: "var(--label-tertiary)", fontWeight: 500, fontSize: "1rem", letterSpacing: "0.02em" }}>
              SOL
            </span>
          </div>
          <div
            className="hig-footnote"
            style={{
              color: "var(--label-secondary)",
              marginTop: "0.25rem",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {usd == null
              ? "—"
              : `≈ $${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`}
          </div>
        </div>

        <div style={{ height: "0.5px", background: "var(--separator)", marginInline: "0.75rem" }} />

        {/* Identity */}
        <div style={{ padding: "1rem 1.25rem 1.125rem", display: "flex", flexDirection: "column", gap: "0.625rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: 0 }}>
              {walletIcon && (
                <img
                  src={walletIcon}
                  alt=""
                  width={18}
                  height={18}
                  style={{ borderRadius: "0.25rem", flexShrink: 0 }}
                />
              )}
              <span
                className="hig-subheadline"
                style={{
                  color: "var(--label-primary)",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {walletName}
              </span>
            </div>
            <span
              className="hig-caption-2"
              style={{
                color: clusterAccent,
                background: `color-mix(in srgb, ${clusterAccent} 14%, transparent)`,
                padding: "0.125rem 0.4375rem",
                borderRadius: "999px",
                fontWeight: 600,
                letterSpacing: "0.02em",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {clusterLabel}
            </span>
          </div>

          <button
            onClick={onCopy}
            onMouseEnter={() => setAddrHover(true)}
            onMouseLeave={() => setAddrHover(false)}
            aria-label={copied ? "Address copied" : "Copy address"}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.625rem",
              width: "100%",
              padding: "0.5rem 0.625rem",
              margin: "-0.5rem -0.625rem",
              background: addrHover ? "var(--accent-fill)" : "transparent",
              border: "none",
              borderRadius: "0.5rem",
              cursor: "pointer",
              transition: "background 120ms ease",
              color: "var(--label-primary)",
            }}
          >
            <span
              className="hig-footnote"
              style={{
                fontFamily: "var(--hig-mono)",
                fontSize: "0.8125rem",
                color: "var(--label-primary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                minWidth: 0,
              }}
            >
              {addr ? `${addr.slice(0, 8)}…${addr.slice(-8)}` : ""}
            </span>
            <span
              style={{
                display: "inline-flex",
                color: copied ? "var(--green)" : addrHover ? "var(--accent)" : "var(--label-tertiary)",
                transition: "color 120ms ease",
                flexShrink: 0,
              }}
            >
              {copied ? <Check size={13} /> : <CopyGlyph size={13} />}
            </span>
          </button>
        </div>

        <div style={{ height: "0.5px", background: "var(--separator)", marginInline: "0.75rem" }} />

        {/* Disconnect */}
        <div style={{ padding: "0.5rem" }}>
          <button
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
            onMouseEnter={() => setDisconnectHover(true)}
            onMouseLeave={() => setDisconnectHover(false)}
            className="hig-callout"
            style={{
              display: "flex",
              alignItems: "center",
              width: "100%",
              padding: "0.625rem 0.875rem",
              background: disconnectHover ? "var(--red)" : "transparent",
              color: disconnectHover ? "white" : "var(--red)",
              textAlign: "left",
              fontWeight: 500,
              borderRadius: "0.5rem",
              transition: "background 80ms ease, color 80ms ease",
              border: "none",
              cursor: "pointer",
            }}
          >
            Disconnect
          </button>
        </div>
      </Popover>
    </>
  );
}
