import type { CSSProperties, ReactNode } from "react";

/** HIG-grouped surface. Server-component-safe: hover effects are CSS,
 *  not JS event handlers, so a server-rendered page can mount this
 *  without forcing the parent tree to "use client". */
export function Card({
  children,
  style,
  className,
  interactive = false,
}: {
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
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
  const baseClassName = interactive ? "sotama-card sotama-card--interactive" : "sotama-card";
  return (
    <div className={className ? `${baseClassName} ${className}` : baseClassName} style={{ ...base, ...style }}>
      {children}
    </div>
  );
}
