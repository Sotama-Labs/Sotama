import type { Slot } from "./types";

export function fmt(n: number | null | undefined, decimals = 4): string {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(decimals >= 4 ? 4 : 2);
  return n.toFixed(decimals);
}

export function fmtUSD(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function shortAddress(addr: string | null | undefined, chars = 4): string {
  if (!addr) return "";
  if (addr.length <= chars * 2 + 1) return addr;
  return `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

export function hexToRgba(hex: string, alpha: number): string | null {
  const h = hex.replace("#", "");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return null;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Render `<label>`, `<label> $<value>` for price, or `<label> <value> <unit>` for amount. */
export function formatSlotValue(slot: Slot): string | null {
  const c = slot.choice;
  if (!c) return null;
  if (!c.needsValue || slot.value == null) return c.label;
  if (c.valueType === "price") return `${c.label} $${slot.value}`;
  return `${c.label} ${slot.value} ${c.unit}`;
}
