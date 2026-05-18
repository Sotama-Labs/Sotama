import { expect } from "chai";
import {
  isExecutableTimeRegime,
  isMarketOpen,
  timeRegimeFor,
} from "../src/market-hours";

/** Build a ms timestamp at a specific NY wall-clock for a given weekday.
 *  We use a fixed reference Monday and offset by `addDays` to land on a
 *  desired weekday (0=Mon..6=Sun, matching the helper's mental model). */
function nyTimestamp(addDays: number, hh: number, mm: number): number {
  // 2026-05-04 is a Monday in NY.
  const iso = `2026-05-${String(4 + addDays).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`;
  return new Date(iso).getTime();
}

describe("isMarketOpen", () => {
  it("24/7 asset classes without exchange sessions are open", () => {
    expect(isMarketOpen("Crypto", nyTimestamp(5, 23, 0))).to.equal(true); // Sat 11pm
    expect(isMarketOpen("FX", nyTimestamp(6, 3, 0))).to.equal(true);      // Sun 3am
    expect(isMarketOpen("Commodity", nyTimestamp(0, 16, 30))).to.equal(true);
  });

  it("US Equity open Mon-Fri 09:30-16:00 ET", () => {
    expect(isMarketOpen("Equity", nyTimestamp(0, 9, 30))).to.equal(true);   // Mon 09:30
    expect(isMarketOpen("Equity", nyTimestamp(0, 15, 59))).to.equal(true);  // Mon 15:59
    expect(isMarketOpen("Equity", nyTimestamp(4, 12, 0))).to.equal(true);   // Fri noon
  });

  it("US Equity closed outside session hours", () => {
    expect(isMarketOpen("Equity", nyTimestamp(0, 9, 29))).to.equal(false);  // Mon 09:29 pre-open
    expect(isMarketOpen("Equity", nyTimestamp(0, 16, 0))).to.equal(false);  // Mon 16:00 close
    expect(isMarketOpen("Equity", nyTimestamp(0, 16, 1))).to.equal(false);  // Mon 16:01
    expect(isMarketOpen("Equity", nyTimestamp(0, 4, 0))).to.equal(false);   // Mon overnight
  });

  it("US Equity closed on weekends", () => {
    expect(isMarketOpen("Equity", nyTimestamp(5, 12, 0))).to.equal(false);  // Sat noon
    expect(isMarketOpen("Equity", nyTimestamp(6, 12, 0))).to.equal(false);  // Sun noon
  });

  it("Metal is executable only during the active CME-style session", () => {
    expect(isMarketOpen("Metal", nyTimestamp(0, 9, 0))).to.equal(true);
    expect(isMarketOpen("Metal", nyTimestamp(0, 17, 30))).to.equal(false);
    expect(isMarketOpen("Metal", nyTimestamp(5, 12, 0))).to.equal(false);
  });
});

describe("timeRegimeFor", () => {
  it("classifies all US equity regimes", () => {
    expect(timeRegimeFor("Equity", nyTimestamp(0, 9, 30))).to.equal("US_EQUITY_REGULAR");
    expect(timeRegimeFor("Equity", nyTimestamp(0, 9, 29))).to.equal("US_EQUITY_PREMARKET");
    expect(timeRegimeFor("Equity", nyTimestamp(0, 16, 0))).to.equal("US_EQUITY_POSTMARKET");
    expect(timeRegimeFor("Equity", nyTimestamp(0, 20, 0))).to.equal("US_EQUITY_OVERNIGHT");
    expect(timeRegimeFor("Equity", nyTimestamp(5, 12, 0))).to.equal("US_EQUITY_WEEKEND");
  });

  it("prefers Pyth marketSession for US equity when present", () => {
    expect(timeRegimeFor("Equity", nyTimestamp(0, 12, 0), {
      pythMarketSession: "preMarket",
    })).to.equal("US_EQUITY_PREMARKET");
    expect(timeRegimeFor("Equity", nyTimestamp(0, 12, 0), {
      pythMarketSession: "postMarket",
    })).to.equal("US_EQUITY_POSTMARKET");
    expect(timeRegimeFor("Equity", nyTimestamp(0, 12, 0), {
      pythMarketSession: "closed",
    })).to.equal("US_EQUITY_OVERNIGHT");
    expect(timeRegimeFor("Equity", nyTimestamp(5, 12, 0), {
      pythMarketSession: "closed",
    })).to.equal("US_EQUITY_WEEKEND");
  });

  it("classifies all metal regimes", () => {
    expect(timeRegimeFor("Metal", nyTimestamp(0, 16, 59))).to.equal("METAL_ACTIVE");
    expect(timeRegimeFor("Metal", nyTimestamp(0, 17, 0))).to.equal("METAL_MAINTENANCE");
    expect(timeRegimeFor("Metal", nyTimestamp(4, 17, 0))).to.equal("METAL_WEEKEND");
    expect(timeRegimeFor("Metal", nyTimestamp(6, 18, 0))).to.equal("METAL_ACTIVE");
    expect(timeRegimeFor("Metal", nyTimestamp(0, 17, 30), {
      pythMarketSession: "regular",
    })).to.equal("METAL_ACTIVE");
  });

  it("classifies crypto normal versus high-vol state", () => {
    expect(timeRegimeFor("Crypto", nyTimestamp(5, 12, 0), { cryptoMoveBps: 49 })).to.equal("CRYPTO_NORMAL");
    expect(timeRegimeFor("Crypto", nyTimestamp(5, 12, 0), { cryptoMoveBps: 50 })).to.equal("CRYPTO_HIGH_VOL");
    expect(timeRegimeFor("Crypto", nyTimestamp(5, 12, 0), {
      cryptoMoveBps: 25,
      cryptoHighVolMoveBps: 20,
    })).to.equal("CRYPTO_HIGH_VOL");
  });

  it("marks only executable regimes as signal-safe", () => {
    expect(isExecutableTimeRegime("US_EQUITY_REGULAR")).to.equal(true);
    expect(isExecutableTimeRegime("METAL_ACTIVE")).to.equal(true);
    expect(isExecutableTimeRegime("CRYPTO_HIGH_VOL")).to.equal(true);
    expect(isExecutableTimeRegime("US_EQUITY_PREMARKET")).to.equal(false);
    expect(isExecutableTimeRegime("US_EQUITY_POSTMARKET")).to.equal(false);
    expect(isExecutableTimeRegime("US_EQUITY_OVERNIGHT")).to.equal(false);
    expect(isExecutableTimeRegime("US_EQUITY_WEEKEND")).to.equal(false);
    expect(isExecutableTimeRegime("METAL_MAINTENANCE")).to.equal(false);
    expect(isExecutableTimeRegime("METAL_WEEKEND")).to.equal(false);
  });
});
