import { expect } from "chai";
import { quantile, RollingQuantileWindow } from "../src/thresholds";

describe("thresholds", () => {
  it("computes the q-quantile of a static array", () => {
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).to.equal(9.1);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).to.equal(5.5);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0)).to.equal(1);
    expect(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 1)).to.equal(10);
  });
  it("rolling window evicts oldest when capacity is exceeded", () => {
    const w = new RollingQuantileWindow(3);
    w.push(1); w.push(2); w.push(3);
    expect(w.q(0.5)).to.equal(2);
    w.push(10);
    expect(w.q(0.5)).to.equal(3);
  });
  it("returns null for an empty window", () => {
    expect(new RollingQuantileWindow(3).q(0.5)).to.equal(null);
  });
  it("size tracks pushes capped at capacity", () => {
    const w = new RollingQuantileWindow(2);
    expect(w.size).to.equal(0);
    w.push(1); expect(w.size).to.equal(1);
    w.push(2); w.push(3); expect(w.size).to.equal(2);
  });
});
