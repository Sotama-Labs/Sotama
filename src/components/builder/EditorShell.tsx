"use client";

import type { ReactNode } from "react";
import { Chevron } from "../icons";

export function EditorShell({
  title,
  side,
  onBack,
  onConfirm,
  ready,
  confirmLabel = "Confirm",
  children,
}: {
  title: string;
  side: "if" | "then";
  onBack: () => void;
  onConfirm: () => void;
  ready: boolean;
  confirmLabel?: string;
  children: ReactNode;
}) {
  return (
    <div className="fade-slide" style={{ padding: "1rem", width: "100%" }}>
      <button
        onClick={onBack}
        className="hig-footnote"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.25rem",
          color: "var(--accent)",
          fontWeight: 500,
          marginBottom: "0.75rem",
        }}
      >
        <span style={{ transform: "rotate(90deg)", display: "inline-flex" }}>
          <Chevron size={9} />
        </span>
        Change {side === "if" ? "trigger" : "action"}
      </button>

      <div
        className="hig-caption-2"
        style={{
          color: "var(--label-secondary)",
          marginBottom: "0.5rem",
          fontWeight: 600,
          padding: "0 0.125rem",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {title}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.625rem" }}>{children}</div>

      <button
        onClick={onConfirm}
        disabled={!ready}
        className="hig-headline"
        style={{
          width: "100%",
          padding: "0.625rem",
          background: ready ? "var(--accent)" : "var(--fill-3)",
          color: ready ? "white" : "var(--label-tertiary)",
          borderRadius: "0.5rem",
          fontWeight: 600,
          marginTop: "0.875rem",
          transition: "background 120ms",
        }}
      >
        {confirmLabel}
      </button>
    </div>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
      <span
        className="hig-caption-1"
        style={{ color: "var(--label-secondary)", fontWeight: 500, padding: "0 0.125rem" }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
