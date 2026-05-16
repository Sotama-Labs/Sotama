import { expect } from "chai";
import { fmt, formatPythPrice, formatTokenAmount } from "../src/lib/format";
import type { TokenRef } from "../src/lib/types";

const token = { decimals: 6 } as TokenRef;

describe("number formatting", () => {
  it("trims insignificant trailing decimal zeros", () => {
    expect(fmt(1.23, 4)).to.equal("1.23");
    expect(fmt(1, 4)).to.equal("1");
    expect(fmt(0.12, 4)).to.equal("0.12");
    expect(fmt(0.00001, 6)).to.equal("0.00001");
  });

  it("keeps meaningful decimal precision for token amounts and prices", () => {
    expect(formatTokenAmount(1.23, token)).to.equal("1.23");
    expect(formatTokenAmount(0.0001, token)).to.equal("0.0001");
    expect(formatPythPrice(85.5)).to.equal("85.5");
    expect(formatPythPrice(0.0123)).to.equal("0.0123");
  });
});
