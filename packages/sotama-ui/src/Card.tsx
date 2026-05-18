import type { CSSProperties, ReactNode } from "react";

export function Card({
  children,
  style,
  onClick,
  interactive = false,
}: {
  children: ReactNode;
  style?: CSSProperties;
  onClick?: () => void;
  interactive?: boolean;
}) {
  const base: CSSProperties = {
    background: "var(--bg-grouped-2)",
    border: "0.5px solid var(--separator)",
    borderRadius: "var(--radius-card)",
    padding: "1rem 1.125rem",
    boxShadow: "var(--shadow-1)",
    cursor: interactive ? "pointer" : "default",
    transition: "transform 160ms ease, box-shadow 160ms ease",
  };
  return (
    <div
      onClick={onClick}
      style={{ ...base, ...style }}
      onMouseEnter={interactive ? (e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = "var(--shadow-2)";
      } : undefined}
      onMouseLeave={interactive ? (e) => {
        (e.currentTarget as HTMLDivElement).style.boxShadow = "var(--shadow-1)";
      } : undefined}
    >
      {children}
    </div>
  );
}
