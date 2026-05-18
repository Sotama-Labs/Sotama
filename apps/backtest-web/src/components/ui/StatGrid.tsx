import type { ReactNode } from "react";

export type StatTile = {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  emphasis?: "primary" | "secondary";
  color?: string;
};

/** Compact responsive stat tiles. Each tile shows a tiny caption label, a
 *  prominent value, and an optional hint underneath. */
export function StatGrid({
  tiles,
  minTileWidth = 160,
}: {
  tiles: readonly StatTile[];
  minTileWidth?: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${minTileWidth}px, 1fr))`,
        gap: "0.625rem",
      }}
    >
      {tiles.map((tile, i) => (
        <div
          key={`${tile.label}-${i}`}
          style={{
            padding: "0.625rem 0.75rem",
            background: "var(--fill-4)",
            borderRadius: "var(--radius-control-m)",
            display: "flex",
            flexDirection: "column",
            gap: "0.1875rem",
          }}
        >
          <span
            className="hig-caption-1"
            style={{
              color: "var(--label-tertiary)",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              fontSize: "0.6875rem",
            }}
          >
            {tile.label}
          </span>
          <span
            className={`bt-num ${tile.emphasis === "primary" ? "hig-title-3" : "hig-headline"}`}
            style={{ color: tile.color ?? "var(--label-primary)" }}
          >
            {tile.value}
          </span>
          {tile.hint ? (
            <span
              className="hig-caption-1"
              style={{ color: "var(--label-tertiary)" }}
            >
              {tile.hint}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
