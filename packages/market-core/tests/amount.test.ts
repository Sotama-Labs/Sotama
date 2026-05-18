import { expect } from "chai";
import { uiToAtomic, atomicToUi, usdToInputAtomic } from "../src/amount";

describe("amount", () => {
  it("converts a UI amount to atomic units (BigInt)", () => {
    expect(uiToAtomic(1.5, 6)).to.equal(1_500_000n);
    expect(uiToAtomic(0.000001, 6)).to.equal(1n);
  });
  it("rounds half-to-even at the atomic boundary", () => {
    // 0.0000005 * 1e6 = 0.5 → toward even (0)
    expect(uiToAtomic(0.0000005, 6)).to.equal(0n);
    // 0.0000015 * 1e6 = 1.5 → toward even (2)
    expect(uiToAtomic(0.0000015, 6)).to.equal(2n);
  });
  it("converts atomic to UI", () => {
    expect(atomicToUi(1_500_000n, 6)).to.equal(1.5);
  });
  it("converts $USD at a given price to input-atomic", () => {
    expect(usdToInputAtomic(100, 1, 6)).to.equal(100_000_000n);
    expect(usdToInputAtomic(100, 200, 9)).to.equal(500_000_000n);
  });
  it("rejects bad inputs", () => {
    expect(() => uiToAtomic(-1, 6)).to.throw();
    expect(() => uiToAtomic(NaN, 6)).to.throw();
    expect(() => usdToInputAtomic(100, 0, 6)).to.throw();
  });
});
