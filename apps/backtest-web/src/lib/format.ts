/** Shared numeric formatters. Numbers are always rendered with tabular-num
 *  (via the `.bt-num` class on the rendering element) so columns stay
 *  aligned even when the values churn. */

export function fmtRatio(v: number | null | undefined): string {
  // 4 decimal places resolves to 1 bp — appropriate for stat-arb basis.
  return v == null || !Number.isFinite(v) ? "—" : `${v.toFixed(4)}×`;
}

export function fmtBps(
  v: number | null | undefined,
  opts: { signed?: boolean; digits?: number } = {},
): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = opts.signed !== false && v > 0 ? "+" : "";
  const digits = opts.digits ?? 1;
  return `${sign}${v.toFixed(digits)} bps`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(v) >= 100 ? 2 : 4,
  }).format(v);
}

export function fmtMs(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v)
    ? "—"
    : `${Math.round(v).toLocaleString()} ms`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}

export function fmtSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return fmtDuration(seconds * 1000);
}

export function fmtPct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
}

export function fmtReturnPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(Math.abs(pct) >= 100 ? 1 : 2)}%`;
}

export function fmtApr(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const pct = v * 100;
  const sign = pct > 0 ? "+" : "";
  const digits = Math.abs(pct) >= 1000 ? 0 : Math.abs(pct) >= 100 ? 1 : 2;
  return `${sign}${pct.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}%`;
}

export function fmtNumber(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString();
}

export function signedColor(
  v: number | null | undefined,
): "var(--green)" | "var(--red)" | "var(--label-primary)" | "var(--label-tertiary)" {
  if (v == null || !Number.isFinite(v)) return "var(--label-tertiary)";
  if (v > 0) return "var(--green)";
  if (v < 0) return "var(--red)";
  return "var(--label-primary)";
}

export function fmtIsoTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString();
}
