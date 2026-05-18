import { expect } from "chai";
import { isMarketOpen } from "../src/market-hours";

/** Build a ms timestamp at a specific NY wall-clock for a given weekday.
 *  We use a fixed reference Monday and offset by `addDays` to land on a
 *  desired weekday (0=Mon..6=Sun, matching the helper's mental model). */
function nyTimestamp(addDays: number, hh: number, mm: number): number {
  // 2026-05-04 is a Monday in NY.
  const iso = `2026-05-${String(4 + addDays).padStart(2, "0")}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00-04:00`;
  return new Date(iso).getTime();
}

describe("isMarketOpen", () => {
  it("non-equity asset classes are always open", () => {
    expect(isMarketOpen("Crypto", nyTimestamp(5, 23, 0))).to.equal(true); // Sat 11pm
    expect(isMarketOpen("Metal", nyTimestamp(0, 9, 0))).to.equal(true);   // Mon 9am pre-open
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
});
