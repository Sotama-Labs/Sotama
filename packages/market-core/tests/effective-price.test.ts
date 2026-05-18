import { expect } from "chai";
import { effectiveBuyPriceUsd, effectiveSellPriceUsd } from "../src/effective-price";

describe("effective-price", () => {
  it("BUY: $100 USDC -> 0.05 XAUT0; effective buy price = $2000/oz", () => {
    const price = effectiveBuyPriceUsd({
      inUsd: 100,
      outAtomic: 50_000n,
      outDecimals: 6,
    });
    expect(price).to.be.closeTo(2000, 1e-9);
  });
  it("SELL: 0.05 XAUT0 -> $99 USDC; effective sell price = $1980/oz", () => {
    const price = effectiveSellPriceUsd({
      inAtomic: 50_000n,
      inDecimals: 6,
      outUsdAtomic: 99_000_000n,
      outUsdDecimals: 6,
    });
    expect(price).to.be.closeTo(1980, 1e-9);
  });
  it("throws on zero out amount", () => {
    expect(() => effectiveBuyPriceUsd({ inUsd: 1, outAtomic: 0n, outDecimals: 6 })).to.throw();
    expect(() => effectiveSellPriceUsd({ inAtomic: 0n, inDecimals: 6, outUsdAtomic: 1n, outUsdDecimals: 6 })).to.throw();
  });
});
