import type { CSSProperties } from "react";

export function Chevron({ size = 10, dir = "down" }: { size?: number; dir?: "up" | "down" }) {
  const style: CSSProperties = {
    transform: dir === "up" ? "rotate(180deg)" : "none",
    transition: "transform 200ms cubic-bezier(0.32, 0.72, 0, 1)",
    flexShrink: 0,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" fill="none" style={style}>
      <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Check({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <path d="M3 7.5 L6 10.5 L11.5 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Plus({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none">
      <path d="M6 1.5 V10.5 M1.5 6 H10.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" style={{ animation: "hig-spin 0.8s linear infinite" }}>
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.8" fill="none" />
      <path d="M7 2 A5 5 0 0 1 12 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}
