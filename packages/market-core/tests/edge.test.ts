import { expect } from "chai";
import { buyEdgeBps, sellEdgeBps } from "../src/edge";

describe("edge", () => {
  it("buy edge is positive when tokenized trades below Pyth", () => {
    expect(buyEdgeBps({ basePriceUsd: 2000, tokenBuyPriceUsd: 1980 }))
      .to.be.closeTo(101.0101, 0.01);
  });
  it("buy edge is negative when tokenized trades above Pyth", () => {
    expect(buyEdgeBps({ basePriceUsd: 2000, tokenBuyPriceUsd: 2020 }))
      .to.be.closeTo(-99.0099, 0.01);
  });
  it("sell edge is positive when tokenized sells above Pyth", () => {
    expect(sellEdgeBps({ basePriceUsd: 2000, tokenSellPriceUsd: 2010 }))
      .to.be.closeTo(50, 1e-6);
  });
  it("rejects non-positive prices", () => {
    expect(() => buyEdgeBps({ basePriceUsd: 0, tokenBuyPriceUsd: 1 })).to.throw();
    expect(() => buyEdgeBps({ basePriceUsd: 1, tokenBuyPriceUsd: 0 })).to.throw();
    expect(() => sellEdgeBps({ basePriceUsd: 0, tokenSellPriceUsd: 1 })).to.throw();
    expect(() => sellEdgeBps({ basePriceUsd: 1, tokenSellPriceUsd: 0 })).to.throw();
  });
});
