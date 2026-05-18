import { expect } from "chai";
import { netEdgeBps } from "../src/cost-model";

describe("cost-model", () => {
  it("subtracts every cost component from gross", () => {
    const out = netEdgeBps({
      grossBps: 100,
      slippageBufferBps: 30,
      landingCostBps: 5,
      failureBufferBps: 5,
      minProfitBps: 20,
    });
    expect(out).to.equal(40);
  });
  it("can return negative net edge when costs exceed gross", () => {
    expect(netEdgeBps({
      grossBps: 5,
      slippageBufferBps: 30,
      landingCostBps: 5,
      failureBufferBps: 5,
      minProfitBps: 20,
    })).to.equal(-55);
  });
});
