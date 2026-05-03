export function fmt(n: number | null | undefined, decimals = 4): string {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(decimals >= 4 ? 4 : 2);
  return n.toFixed(decimals);
}

export function shortAddress(addr: string | null | undefined): string {
  if (!addr) return "";
  if (addr.length <= 9) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}
