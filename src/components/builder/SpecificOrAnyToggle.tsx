"use client";

export function SpecificOrAnyToggle({
  mode,
  onChange,
}: {
  mode: "specific" | "any";
  onChange: (next: "specific" | "any") => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "inline-flex",
        padding: "0.125rem",
        background: "var(--fill-3)",
        borderRadius: "999px",
        gap: "0.125rem",
      }}
    >
      {(["specific", "any"] as const).map((m) => {
        const selected = mode === m;
        return (
          <button
            key={m}
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(m)}
            className="hig-caption-1"
            style={{
              padding: "0.1875rem 0.625rem",
              borderRadius: "999px",
              background: selected ? "var(--bg-system)" : "transparent",
              color: selected ? "var(--label-primary)" : "var(--label-secondary)",
              fontWeight: 500,
              boxShadow: selected ? "var(--shadow-1)" : "none",
              transition: "background 160ms, color 160ms, box-shadow 160ms",
            }}
          >
            {m === "specific" ? "Specific" : "Any"}
          </button>
        );
      })}
    </div>
  );
}
