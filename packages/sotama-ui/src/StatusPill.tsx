import type { ReactNode } from "react";

export type StatusKind = "ok" | "warn" | "bad" | "neutral";

const FG: Record<StatusKind, string> = {
  ok: "var(--green)",
  warn: "var(--orange)",
  bad: "var(--red)",
  neutral: "var(--label-secondary)",
};
const BG: Record<StatusKind, string> = {
  ok: "rgba(52,199,89,0.14)",
  warn: "rgba(255,149,0,0.14)",
  bad: "rgba(255,59,48,0.14)",
  neutral: "var(--fill-3)",
};

export function StatusPill({ kind, children }: { kind: StatusKind; children: ReactNode }) {
  return (
    <span
      className="hig-caption-1"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "0.1875rem 0.5rem",
        borderRadius: "999px",
        color: FG[kind],
        background: BG[kind],
        fontWeight: 600,
        letterSpacing: "0.012em",
      }}
    >
      {children}
    </span>
  );
}
