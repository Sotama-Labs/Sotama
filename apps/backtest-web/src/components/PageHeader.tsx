import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@sotama/ui";

export function PageHeader({
  trailing,
  back,
}: {
  trailing?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="bt-page-header">
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <Link href="/" style={{ textDecoration: "none" }} aria-label="Sotama backtest home">
          <BrandMark subtitle="Backtest" />
        </Link>
        {back ? (
          <Link
            href={back.href}
            className="hig-footnote"
            style={{ color: "var(--accent)", textDecoration: "none" }}
          >
            ← {back.label}
          </Link>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>{trailing}</div>
    </header>
  );
}
