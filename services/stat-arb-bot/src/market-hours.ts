import type { AssetClass } from "@sotama/market-core";

/** US equity regular session: 9:30 AM - 4:00 PM ET, Mon-Fri.
 *
 *  Doesn't model US market holidays (~9 days/year). On a holiday the
 *  Pyth feed simply doesn't tick, so the bot idles naturally — we don't
 *  waste Jupiter RPS on those days even without an explicit calendar.
 *
 *  Asset classes other than Equity are treated as 24/7 (Crypto, Metal,
 *  FX, Commodity all stream around the clock on Lazer). */
export function isMarketOpen(
  assetClass: AssetClass,
  nowMs: number = Date.now(),
): boolean {
  if (assetClass !== "Equity") return true;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (weekday === "Sat" || weekday === "Sun") return false;

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}
