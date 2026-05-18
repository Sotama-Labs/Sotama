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
  minTileWidth = 144,
}: {
  tiles: readonly StatTile[];
  minTileWidth?: number;
}) {
  return (
    <div
      className="bt-stat-grid"
      style={{
        gridTemplateColumns: `repeat(auto-fit, minmax(${minTileWidth}px, 1fr))`,
      }}
    >
      {tiles.map((tile, i) => (
        <div
          key={`${tile.label}-${i}`}
          className="bt-stat-tile"
        >
          <span
            className="hig-caption-1 bt-eyebrow"
          >
            {tile.label}
          </span>
          <span
            className={`bt-stat-value bt-num ${tile.emphasis === "primary" ? "hig-title-3" : "hig-headline"}`}
            style={{ color: tile.color ?? "var(--label-primary)" }}
          >
            {tile.value}
          </span>
          {tile.hint ? (
            <span
              className="hig-caption-1 bt-stat-hint"
            >
              {tile.hint}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
