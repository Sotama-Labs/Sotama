import type { ReactNode } from "react";
import { Card } from "@sotama/ui";

/** Titled section. The header row is consistent across every panel: title +
 *  optional subtitle on the left, optional `action` slot on the right.
 *  Wraps its children in a sotama-style Card so every panel has the same
 *  surface treatment. */
export function Section({
  title,
  subtitle,
  action,
  children,
  density = "default",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  density?: "default" | "compact";
}) {
  return (
    <Card style={{ padding: density === "compact" ? "0.875rem 1rem" : "1.125rem 1.125rem" }}>
      <header
        style={{
          display: "flex",
          gap: "0.75rem",
          alignItems: "flex-start",
          justifyContent: "space-between",
          flexWrap: "wrap",
          marginBottom: density === "compact" ? "0.5rem" : "0.875rem",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <p className="hig-headline" style={{ margin: 0 }}>
            {title}
          </p>
          {subtitle ? (
            <p
              className="hig-caption-1"
              style={{ color: "var(--label-tertiary)", margin: "0.1875rem 0 0" }}
            >
              {subtitle}
            </p>
          ) : null}
        </div>
        {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
      </header>
      <div>{children}</div>
    </Card>
  );
}
