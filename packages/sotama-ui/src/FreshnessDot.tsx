export type FreshnessLevel = "live" | "warm" | "stale" | "dead";

export function levelForAgeMs(ageMs: number | null): FreshnessLevel {
  if (ageMs == null) return "dead";
  if (ageMs <= 10_000) return "live";
  if (ageMs <= 60_000) return "warm";
  if (ageMs <= 5 * 60_000) return "stale";
  return "dead";
}

const COLOR: Record<FreshnessLevel, string> = {
  live: "var(--green)",
  warm: "var(--orange)",
  stale: "var(--red)",
  dead: "var(--label-tertiary)",
};

export function FreshnessDot({ ageMs, size = 8 }: { ageMs: number | null; size?: number }) {
  const level = levelForAgeMs(ageMs);
  return (
    <span
      aria-label={`${level} (${ageMs ?? "—"}ms)`}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: COLOR[level],
        boxShadow: level === "live" ? "0 0 0 3px rgba(52, 199, 89, 0.18)" : "none",
      }}
    />
  );
}
