"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TokenRef } from "@/lib/types";

export type AmountPreset =
  | number
  | { label: string; value: number }
  | { label: string; apply: (current: number | null) => number };

export function AmountInput({
  value,
  token,
  presets,
  onChange,
  onCommit,
  placeholder,
  autoFocus = true,
  unit,
  annotation,
}: {
  value: number | null;
  token: TokenRef | null;
  presets?: AmountPreset[];
  onChange: (v: number | null) => void;
  onCommit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  unit?: string;
  annotation?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const ghostRef = useRef<HTMLSpanElement | null>(null);
  const [local, setLocal] = useState<string>(value != null ? String(value) : "");
  const [inputWidth, setInputWidth] = useState(48);

  useEffect(() => {
    setLocal(value != null ? String(value) : "");
  }, [value]);

  useEffect(() => {
    if (!autoFocus) return;
    const t = window.setTimeout(() => ref.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [autoFocus]);

  // Match the input width to the actual rendered text via a hidden ghost
  // span. Removes the slack the HTML `size` attribute leaves so the
  // annotation can sit immediately to the right of the typed number.
  useLayoutEffect(() => {
    if (ghostRef.current) {
      const w = ghostRef.current.getBoundingClientRect().width;
      setInputWidth(Math.max(Math.ceil(w) + 2, 16));
    }
  }, [local, placeholder]);

  const display = unit ?? token?.symbol ?? "";
  const ghostText = local || placeholder || "0.0";

  const commit = (raw: string) => {
    const num = parseFloat(raw);
    if (raw === "" || isNaN(num)) {
      onChange(null);
      return;
    }
    onChange(num);
  };

  return (
    <div>
      <div
        onClick={() => ref.current?.focus()}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          padding: "0.5rem 0.75rem",
          background: "var(--fill-4)",
          border: "0.5px solid var(--separator)",
          borderRadius: "0.5rem",
          cursor: "text",
          position: "relative",
        }}
      >
        {/* Ghost span — measures the typed text so the input hugs it. */}
        <span
          ref={ghostRef}
          aria-hidden="true"
          className="hig-body"
          style={{
            position: "absolute",
            visibility: "hidden",
            pointerEvents: "none",
            whiteSpace: "pre",
            fontWeight: 500,
            fontFeatureSettings: '"tnum"',
          }}
        >
          {ghostText}
        </span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "baseline",
            gap: "0.25rem",
            minWidth: 0,
          }}
        >
          <input
            ref={ref}
            type="number"
            inputMode="decimal"
            value={local}
            onChange={(e) => {
              setLocal(e.target.value);
              commit(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit?.();
            }}
            placeholder={placeholder ?? "0.0"}
            className="hig-body"
            style={{
              width: inputWidth,
              border: "none",
              outline: "none",
              background: "transparent",
              fontWeight: 500,
              color: "var(--label-primary)",
              padding: 0,
              MozAppearance: "textfield",
              WebkitAppearance: "none",
              appearance: "textfield",
              fontFeatureSettings: '"tnum"',
            }}
          />
          {annotation}
        </span>
        {display && (
          <span
            className="hig-footnote"
            style={{
              color: "var(--label-secondary)",
              fontWeight: 500,
              marginLeft: "auto",
            }}
          >
            {display}
          </span>
        )}
      </div>

      {presets && presets.length > 0 && (
        <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
          {presets.map((p, i) => {
            const label =
              typeof p === "number" ? `${p}${display ? ` ${display}` : ""}` : p.label;
            const onPress = () => {
              let next: number;
              if (typeof p === "number") {
                next = p;
              } else if ("apply" in p) {
                const parsed = parseFloat(local);
                const current = isNaN(parsed) ? null : parsed;
                next = p.apply(current);
              } else {
                next = p.value;
              }
              const formatted = Number.isFinite(next) ? String(next) : "";
              setLocal(formatted);
              commit(formatted);
            };
            return (
              <button
                key={`${i}:${label}`}
                onClick={onPress}
                className="hig-footnote"
                style={{
                  padding: "0.1875rem 0.625rem",
                  fontWeight: 500,
                  background: "var(--fill-3)",
                  borderRadius: "999px",
                  color: "var(--label-primary)",
                  fontFeatureSettings: '"tnum"',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
