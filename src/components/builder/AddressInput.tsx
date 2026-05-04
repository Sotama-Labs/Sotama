"use client";

import { useEffect, useRef, useState } from "react";
import { isValidMintCandidate } from "@/lib/tokens";
import { shortAddress } from "@/lib/format";

const RECENTS_KEY = "sotama:recent-destinations:v1";

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

export function rememberDestination(addr: string) {
  if (typeof window === "undefined") return;
  try {
    const cur = loadRecents();
    const next = [addr, ...cur.filter((a) => a !== addr)].slice(0, 6);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
}

export function AddressInput({
  value,
  onChange,
  onCommit,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  onCommit?: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [local, setLocal] = useState(value ?? "");
  const [recents] = useState<string[]>(() => loadRecents());

  useEffect(() => setLocal(value ?? ""), [value]);
  useEffect(() => {
    const t = window.setTimeout(() => ref.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  const valid = isValidMintCandidate(local.trim());

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    onChange(isValidMintCandidate(trimmed) ? trimmed : null);
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.375rem",
          padding: "0.5rem 0.75rem",
          background: "var(--fill-4)",
          border: `0.5px solid ${local && !valid ? "var(--red)" : "var(--separator)"}`,
          borderRadius: "0.5rem",
        }}
      >
        <input
          ref={ref}
          type="search"
          name="sotama-destination-address"
          id="sotama-destination-address"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore="true"
          data-lpignore="true"
          data-form-type="other"
          value={local}
          onChange={(e) => {
            setLocal(e.target.value);
            commit(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && valid) onCommit?.();
          }}
          placeholder="Solana account address"
          className="hig-footnote"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontFamily: "var(--hig-mono)",
            fontWeight: 500,
            color: "var(--label-primary)",
            padding: 0,
            minWidth: 0,
          }}
        />
      </div>

      {recents.length > 0 && !local && (
        <div style={{ marginTop: "0.5rem" }}>
          <div className="hig-caption-2" style={{ color: "var(--label-tertiary)", marginBottom: "0.25rem" }}>
            Recent
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.25rem" }}>
            {recents.map((r) => (
              <button
                key={r}
                onClick={() => {
                  setLocal(r);
                  commit(r);
                }}
                className="hig-caption-1"
                style={{
                  padding: "0.1875rem 0.5rem",
                  background: "var(--fill-3)",
                  borderRadius: "999px",
                  fontFamily: "var(--hig-mono)",
                  color: "var(--label-primary)",
                }}
              >
                {shortAddress(r, 4)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
