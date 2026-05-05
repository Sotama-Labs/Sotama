"use client";

import { Fragment } from "react";
import { Chevron } from "../icons";
import { MenuRow } from "./MenuRow";

export type GroupableOption = {
  kind: string;
  label: string;
  group?: string;
  description?: string;
  /** When true, render greyed-out and ignore clicks. */
  disabled?: boolean;
  /** Optional hover/caption text shown when `disabled` is true. */
  disabledReason?: string;
};

export function PopoverList<T extends GroupableOption>({
  title,
  options,
  selectedKind,
  onPick,
  onBack,
}: {
  title: string;
  options: T[];
  selectedKind: string | null;
  onPick: (o: T) => void;
  onBack?: () => void;
}) {
  const groups: Array<{ name: string | null; items: T[] }> = [];
  for (const o of options) {
    const name = o.group ?? null;
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, items: [] };
      groups.push(g);
    }
    g.items.push(o);
  }

  return (
    <div className="fade-slide" style={{ width: "100%" }}>
      <div
        style={{
          padding: "0.875rem 1rem 0.375rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "1.125rem",
              height: "1.125rem",
              borderRadius: "999px",
              color: "var(--label-secondary)",
              transform: "rotate(90deg)",
            }}
          >
            <Chevron size={9} />
          </button>
        )}
        <span
          className="hig-caption-2"
          style={{
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--label-secondary)",
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ paddingBottom: "0.25rem" }}>
        {groups.map((g, gi) => (
          <Fragment key={`${g.name ?? "default"}-${gi}`}>
            {g.name && (
              <div
                className="hig-caption-2"
                style={{
                  padding: "0.625rem 1rem 0.25rem",
                  color: "var(--label-tertiary)",
                  textTransform: "uppercase",
                  fontWeight: 600,
                  letterSpacing: "0.04em",
                }}
              >
                {g.name}
              </div>
            )}
            {g.items.map((o) => (
              <MenuRow
                key={o.kind}
                label={o.label}
                description={o.description}
                selected={o.kind === selectedKind}
                onClick={() => onPick(o)}
                disabled={o.disabled}
                disabledReason={o.disabledReason}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
