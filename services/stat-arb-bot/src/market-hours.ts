import type { AssetClass, TimeRegime } from "@sotama/market-core";

type NyClock = {
  weekday: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun" | string;
  minutes: number;
};

export type TimeRegimeOptions = {
  /** Absolute move from the previous observed price. Crypto is 24/7, so
   *  CRYPTO_HIGH_VOL is market-state based rather than wall-clock based. */
  cryptoMoveBps?: number;
  cryptoHighVolMoveBps?: number;
  /** Pyth Pro payload field. Values documented by Pyth are regular,
   *  preMarket, postMarket, overNight, and closed. */
  pythMarketSession?: string | null;
};

/** US equity regular session: 9:30 AM - 4:00 PM ET, Mon-Fri.
 *
 *  Doesn't model US market holidays (~9 days/year). On a holiday the Pyth
 *  feed usually doesn't tick, so the bot idles naturally without an explicit
 *  holiday calendar.
 *
 *  Metal sessions use a CME-style first-pass model: Sun 18:00 ET through Fri
 *  17:00 ET, with daily 17:00-18:00 ET maintenance. This is intentionally an
 *  analytics regime label, not a holiday-aware exchange calendar. */
export function timeRegimeFor(
  assetClass: AssetClass,
  nowMs: number = Date.now(),
  opts: TimeRegimeOptions = {},
): TimeRegime | null {
  if (assetClass === "Crypto") {
    const threshold = opts.cryptoHighVolMoveBps ?? 50;
    return (opts.cryptoMoveBps ?? 0) >= threshold
      ? "CRYPTO_HIGH_VOL"
      : "CRYPTO_NORMAL";
  }

  const ny = nyClock(nowMs);
  if (assetClass === "Equity") {
    return equityRegimeFromPythSession(opts.pythMarketSession, ny) ?? usEquityRegime(ny);
  }
  if (assetClass === "Metal") {
    return opts.pythMarketSession && opts.pythMarketSession !== "closed"
      ? "METAL_ACTIVE"
      : metalRegime(ny);
  }
  return null;
}

export function isExecutableTimeRegime(regime: TimeRegime | null): boolean {
  switch (regime) {
    case "US_EQUITY_PREMARKET":
    case "US_EQUITY_POSTMARKET":
    case "US_EQUITY_OVERNIGHT":
    case "US_EQUITY_WEEKEND":
    case "METAL_MAINTENANCE":
    case "METAL_WEEKEND":
      return false;
    default:
      return true;
  }
}

export function isMarketOpen(
  assetClass: AssetClass,
  nowMs: number = Date.now(),
): boolean {
  return isExecutableTimeRegime(timeRegimeFor(assetClass, nowMs));
}

function nyClock(nowMs: number): NyClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return { weekday, minutes: hour * 60 + minute };
}

function usEquityRegime({ weekday, minutes }: NyClock): TimeRegime {
  if (weekday === "Sat" || weekday === "Sun") return "US_EQUITY_WEEKEND";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "US_EQUITY_REGULAR";
  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "US_EQUITY_PREMARKET";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "US_EQUITY_POSTMARKET";
  return "US_EQUITY_OVERNIGHT";
}

function equityRegimeFromPythSession(
  marketSession: string | null | undefined,
  clock: NyClock,
): TimeRegime | null {
  switch (marketSession) {
    case "regular":
      return "US_EQUITY_REGULAR";
    case "preMarket":
      return "US_EQUITY_PREMARKET";
    case "postMarket":
      return "US_EQUITY_POSTMARKET";
    case "overNight":
      return "US_EQUITY_OVERNIGHT";
    case "closed":
      return clock.weekday === "Sat" || clock.weekday === "Sun"
        ? "US_EQUITY_WEEKEND"
        : "US_EQUITY_OVERNIGHT";
    default:
      return null;
  }
}

function metalRegime({ weekday, minutes }: NyClock): TimeRegime {
  if (weekday === "Sat") return "METAL_WEEKEND";
  if (weekday === "Sun" && minutes < 18 * 60) return "METAL_WEEKEND";
  if (weekday === "Fri" && minutes >= 17 * 60) return "METAL_WEEKEND";
  if (minutes >= 17 * 60 && minutes < 18 * 60) return "METAL_MAINTENANCE";
  return "METAL_ACTIVE";
}
