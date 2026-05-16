import type { TokenRef } from "./types";

function trimTrailingDecimalZeros(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

export function fmt(n: number | null | undefined, decimals = 4): string {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return trimTrailingDecimalZeros(n.toFixed(decimals >= 4 ? 4 : 2));
  return trimTrailingDecimalZeros(n.toFixed(decimals));
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

/** Format a token amount honoring the token's own decimals — never trail useless zeros. */
export function formatTokenAmount(value: number | null | undefined, token: TokenRef | null | undefined): string {
  if (value == null || isNaN(value)) return "—";
  const decimals = token?.decimals ?? 4;
  if (value === 0) return "0";
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value >= 1) return trimTrailingDecimalZeros(value.toFixed(Math.min(decimals, 4)));
  return trimTrailingDecimalZeros(value.toFixed(Math.min(decimals, 6)));
}

/** Format a Pyth price (already scaled — see oracles.ts) for display. */
export function formatPythPrice(price: number | null | undefined): string {
  if (price == null || isNaN(price)) return "—";
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return trimTrailingDecimalZeros(price.toFixed(2));
  if (price >= 0.01) return trimTrailingDecimalZeros(price.toFixed(4));
  return trimTrailingDecimalZeros(price.toFixed(6));
}
