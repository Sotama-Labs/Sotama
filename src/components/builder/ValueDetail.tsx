"use client";

import { useEffect, useRef, useState } from "react";
import { Chevron } from "../icons";
import type { Option } from "@/lib/types";

export function ValueDetail({
  option,
  value,
  onConfirm,
  onBack,
  side,
  livePrice,
}: {
  option: Option;
  value: string | number | null;
  onConfirm: (v: number) => void;
  onBack: () => void;
  side: "if" | "then";
  livePrice: number | null;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [local, setLocal] = useState<string>(value != null ? String(value) : "");

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  const isPrice = option.valueType === "price";
  const presets = isPrice
    ? livePrice != null
      ? [
          Math.round(livePrice * 0.85),
          Math.round(livePrice * 0.95),
          Math.round(livePrice * 1.05),
          Math.round(livePrice * 1.15),
        ]
      : [120, 140, 160, 180]
    : [0.5, 1, 5, 10];

  const commit = () => {
    const num = parseFloat(local);
    if (!isNaN(num) && num > 0) onConfirm(num);
  };

  const valid = local !== "" && parseFloat(local) > 0;

  return (
    <div className="fade-slide" style={{ padding: "0.75rem" }}>
      <button
        onClick={onBack}
        className="hig-footnote"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
          color: "var(--accent)",
          fontWeight: 500,
          marginBottom: "0.625rem",
        }}
      >
        <span style={{ transform: "rotate(90deg)", display: "inline-flex" }}>
          <Chevron size={9} />
        </span>
        Change {side === "if" ? "trigger" : "action"}
      </button>

      <div
        className="hig-caption-1"
        style={{
          color: "var(--label-secondary)",
          marginBottom: "0.375rem",
          fontWeight: 500,
          padding: "0 0.125rem",
        }}
      >
        {option.label}
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
          marginBottom: "0.625rem",
        }}
      >
        {isPrice && <span className="hig-body" style={{ color: "var(--label-secondary)" }}>$</span>}
        <input
          ref={inputRef}
          type="number"
          inputMode="decimal"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && commit()}
          placeholder={isPrice ? livePrice ? livePrice.toFixed(2) : "150.00" : "1.0"}
          className="hig-body"
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            fontWeight: 500,
            color: "var(--label-primary)",
            padding: 0,
            minWidth: 0,
            MozAppearance: "textfield",
            WebkitAppearance: "none",
            appearance: "textfield",
          }}
        />
        <span className="hig-footnote" style={{ color: "var(--label-secondary)", fontWeight: 500 }}>
          {option.unit}
        </span>
      </div>

      {isPrice && livePrice != null && (
        <div
          className="hig-caption-1"
          style={{
            color: "var(--label-tertiary)",
            marginBottom: "0.5rem",
            padding: "0 0.125rem",
            fontFeatureSettings: '"tnum"',
          }}
        >
          Live SOL · ${livePrice.toFixed(2)}
        </div>
      )}

      <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
        {presets.map((p) => (
          <button
            key={p}
            onClick={() => setLocal(String(p))}
            className="hig-footnote"
            style={{
              padding: "0.1875rem 0.625rem",
              fontWeight: 500,
              background: "var(--fill-3)",
              borderRadius: "999px",
              color: "var(--label-primary)",
            }}
          >
            {isPrice ? `$${p}` : `${p} ${option.unit}`}
          </button>
        ))}
      </div>

      <button
        onClick={commit}
        disabled={!valid}
        className="hig-headline"
        style={{
          width: "100%",
          padding: "0.5rem",
          background: valid ? "var(--accent)" : "var(--fill-3)",
          color: valid ? "white" : "var(--label-tertiary)",
          borderRadius: "0.5rem",
          fontWeight: 600,
          transition: "background 120ms",
        }}
      >
        Confirm
      </button>
    </div>
  );
}
