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
    <Card
      className={`bt-panel ${density === "compact" ? "bt-panel--compact" : ""}`}
      style={{ padding: density === "compact" ? "0.875rem 1rem" : "1.125rem 1.125rem" }}
    >
      <header className={`bt-section-header ${density === "compact" ? "bt-section-header--compact" : ""}`}>
        <div className="bt-section-copy">
          <h2 className="hig-headline bt-section-title">
            {title}
          </h2>
          {subtitle ? (
            <p
              className="hig-caption-1 bt-section-subtitle"
            >
              {subtitle}
            </p>
          ) : null}
        </div>
        {action ? <div className="bt-section-action">{action}</div> : null}
      </header>
      <div>{children}</div>
    </Card>
  );
}
