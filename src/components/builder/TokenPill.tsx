"use client";

import { useState } from "react";
import type { TokenRef } from "@/lib/types";

function colorFor(symbol: string): string {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 360;
  return `hsl(${h}, 60%, 55%)`;
}

export function TokenPill({
  token,
  size = 16,
}: {
  token: TokenRef;
  size?: number;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const showLogo = token.logo && !logoFailed;
  const initial = token.symbol[0]?.toUpperCase() ?? "?";

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.3125rem",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ fontWeight: 500 }}>{token.symbol}</span>
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          flexShrink: 0,
          background: showLogo ? "var(--fill-3)" : colorFor(token.symbol),
          color: "white",
          fontSize: size * 0.55,
          fontWeight: 700,
          lineHeight: 1,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          boxShadow: "inset 0 0 0 0.5px rgba(0,0,0,0.10)",
        }}
      >
        {showLogo ? (
          <img
            src={token.logo}
            alt=""
            width={size}
            height={size}
            onError={() => setLogoFailed(true)}
            style={{ width: size, height: size, display: "block", objectFit: "cover" }}
          />
        ) : (
          initial
        )}
      </span>
    </span>
  );
}
