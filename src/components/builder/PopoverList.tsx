"use client";

import type { Option } from "@/lib/types";
import { MenuRow } from "./MenuRow";

export function PopoverList({
  title,
  options,
  selectedId,
  onPick,
}: {
  title: string;
  options: Option[];
  selectedId: string | undefined;
  onPick: (o: Option) => void;
}) {
  return (
    <div className="fade-slide">
      <div
        className="hig-caption-2"
        style={{
          padding: "0.625rem 0.75rem 0.25rem",
          fontWeight: 600,
          textTransform: "uppercase",
          color: "var(--label-secondary)",
        }}
      >
        {title}
      </div>
      <div style={{ paddingBottom: "0.25rem" }}>
        {options.map((o) => (
          <MenuRow key={o.id} label={o.label} selected={o.id === selectedId} onClick={() => onPick(o)} />
        ))}
      </div>
    </div>
  );
}
