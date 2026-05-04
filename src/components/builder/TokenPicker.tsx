"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenRef } from "@/lib/types";
import {
  POPULAR_TOKENS,
  isValidMintCandidate,
  manualTokenRef,
  metadataSourceLabel,
  resolveToken,
} from "@/lib/tokens";
import { Chevron } from "../icons";
import { TokenPill } from "./TokenPill";

type ResolveState =
  | { phase: "idle" }
  | { phase: "resolving"; mint: string }
  | { phase: "resolved"; token: TokenRef }
  | { phase: "manual"; mint: string; symbol: string; decimals: string }
  | { phase: "invalid"; input: string };

export function TokenPicker({
  title = "Pick a token",
  selected,
  onSelect,
  onBack,
  exclude,
}: {
  title?: string;
  selected?: TokenRef | null;
  onSelect: (token: TokenRef) => void;
  onBack?: () => void;
  exclude?: TokenRef | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [state, setState] = useState<ResolveState>({ phase: "idle" });

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = POPULAR_TOKENS.filter((t) => !exclude || t.mint !== exclude.mint);
    if (!q) return list;
    return list.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.mint.toLowerCase().startsWith(q),
    );
  }, [query, exclude]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!isValidMintCandidate(trimmed)) {
      setState((s) => (s.phase === "resolving" || s.phase === "resolved" ? { phase: "idle" } : s));
      return;
    }
    let alive = true;
    setState({ phase: "resolving", mint: trimmed });
    resolveToken(trimmed).then((res) => {
      if (!alive) return;
      if (res.status === "ok") setState({ phase: "resolved", token: res.token });
      else if (res.status === "manual")
        setState({ phase: "manual", mint: res.mint, symbol: "", decimals: "" });
      else setState({ phase: "invalid", input: trimmed });
    });
    return () => {
      alive = false;
    };
  }, [query]);

  const commitManual = () => {
    if (state.phase !== "manual") return;
    const dec = parseInt(state.decimals, 10);
    if (!state.symbol || isNaN(dec) || dec < 0 || dec > 18) return;
    onSelect(manualTokenRef(state.mint, state.symbol, dec));
  };

  return (
    <div className="fade-slide" style={{ padding: "1rem", width: "100%" }}>
      <div
        style={{
          padding: "0 0.125rem 0.5rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "1.125rem",
              height: "1.125rem",
              borderRadius: "999px",
              color: "var(--label-secondary)",
              transform: "rotate(90deg)",
            }}
          >
            <Chevron size={9} />
          </button>
        )}
        <span
          className="hig-caption-2"
          style={{
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--label-secondary)",
          }}
        >
          {title}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.375rem",
          padding: "0.5rem 0.75rem",
          background: "var(--fill-4)",
          border: "0.5px solid var(--separator)",
          borderRadius: "0.5rem",
          marginBottom: "0.5rem",
        }}
      >
        <input
          ref={inputRef}
          type="search"
          name="sotama-token-search"
          id="sotama-token-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Symbol or paste contract address"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-form-type="other"
          className="hig-footnote"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontWeight: 500,
            color: "var(--label-primary)",
            padding: 0,
            minWidth: 0,
            fontFamily: query.length > 12 ? "var(--hig-mono)" : "inherit",
          }}
        />
      </div>

      {state.phase === "resolving" && (
        <div
          className="hig-footnote"
          style={{ color: "var(--label-secondary)", padding: "0.5rem 0.125rem" }}
        >
          Resolving…
        </div>
      )}

      {state.phase === "resolved" && (
        <button
          onClick={() => onSelect(state.token)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.5rem 0.625rem",
            background: "var(--accent-fill)",
            color: "var(--label-primary)",
            borderRadius: "0.5rem",
            marginBottom: "0.5rem",
            transition: "background 120ms",
          }}
        >
          <TokenPill token={state.token} />
          <span className="hig-caption-1" style={{ color: "var(--label-secondary)" }}>
            {metadataSourceLabel(state.token.metadataSource)}
          </span>
        </button>
      )}

      {state.phase === "manual" && (
        <div
          style={{
            padding: "0.5rem 0.625rem",
            background: "var(--fill-4)",
            borderRadius: "0.5rem",
            marginBottom: "0.5rem",
          }}
        >
          <div className="hig-caption-1" style={{ color: "var(--label-secondary)", marginBottom: "0.375rem" }}>
            No metadata found. Enter manually:
          </div>
          <div style={{ display: "flex", gap: "0.375rem", marginBottom: "0.375rem" }}>
            <input
              type="text"
              name="sotama-manual-symbol"
              id="sotama-manual-symbol"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="characters"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              value={state.symbol}
              onChange={(e) =>
                setState((s) => (s.phase === "manual" ? { ...s, symbol: e.target.value } : s))
              }
              placeholder="Symbol"
              className="hig-footnote"
              style={{
                flex: 1,
                padding: "0.375rem 0.5rem",
                border: "0.5px solid var(--separator)",
                borderRadius: "0.375rem",
                background: "var(--bg-system)",
                outline: "none",
                color: "var(--label-primary)",
              }}
            />
            <input
              value={state.decimals}
              onChange={(e) =>
                setState((s) => (s.phase === "manual" ? { ...s, decimals: e.target.value } : s))
              }
              placeholder="Decimals"
              type="number"
              min={0}
              max={18}
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              className="hig-footnote"
              style={{
                width: "5.5rem",
                padding: "0.375rem 0.5rem",
                border: "0.5px solid var(--separator)",
                borderRadius: "0.375rem",
                background: "var(--bg-system)",
                outline: "none",
                color: "var(--label-primary)",
              }}
            />
          </div>
          <button
            onClick={commitManual}
            className="hig-footnote"
            style={{
              width: "100%",
              padding: "0.375rem",
              background: "var(--accent)",
              color: "white",
              borderRadius: "0.375rem",
              fontWeight: 600,
            }}
          >
            Use this token
          </button>
        </div>
      )}

      {state.phase === "invalid" && (
        <div
          className="hig-caption-1"
          style={{ color: "var(--red)", padding: "0.25rem 0.125rem 0.5rem" }}
        >
          Not a valid Solana mint address.
        </div>
      )}

      {filtered.length > 0 && (
        <div
          className="hig-caption-2"
          style={{
            padding: "0.375rem 0.125rem 0.25rem",
            color: "var(--label-tertiary)",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Popular
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", maxHeight: "18rem", overflowY: "auto" }}>
        {filtered.map((t) => {
          const isSel = selected?.mint === t.mint;
          return (
            <button
              key={t.mint}
              onClick={() => onSelect(t)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.625rem 0.625rem",
                background: isSel ? "var(--accent-fill)" : "transparent",
                color: "var(--label-primary)",
                textAlign: "left",
                borderRadius: "0.5rem",
                transition: "background 80ms",
              }}
              onMouseEnter={(e) => {
                if (!isSel)
                  (e.currentTarget as HTMLButtonElement).style.background = "var(--fill-4)";
              }}
              onMouseLeave={(e) => {
                if (!isSel) (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              <TokenPill token={t} />
              <span className="hig-caption-1" style={{ color: "var(--label-tertiary)" }}>
                {t.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
