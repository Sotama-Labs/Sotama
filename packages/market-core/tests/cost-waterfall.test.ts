import { expect } from "chai";
import {
  buildCostScenarios,
  buildCostWaterfall,
} from "../src/cost-waterfall";

const baseCosts = {
  slippageBufferBps: 30,
  landingCostBps: 5,
  failureBufferBps: 5,
  minProfitBps: 20,
};

describe("cost waterfall", () => {
  it("decomposes gross edge into named, signed bps steps", () => {
    const w = buildCostWaterfall({ grossBps: 80, costs: baseCosts });
    expect(w.grossBps).to.equal(80);
    expect(w.estimatedExecutionCostBps).to.equal(40);
    expect(w.requiredProfitBps).to.equal(20);
    expect(w.entryThresholdBps).to.equal(60);
    expect(w.edgeAfterCostBps).to.equal(20);
    expect(w.steps.map((s) => s.code)).to.deep.equal([
      "GROSS",
      "SLIPPAGE_BUFFER",
      "LANDING_COST",
      "FAILURE_BUFFER",
      "REQUIRED_PROFIT",
      "EDGE_AFTER_COST",
    ]);
    expect(w.steps.find((s) => s.code === "SLIPPAGE_BUFFER")!.bps).to.equal(-30);
    expect(w.steps.find((s) => s.code === "EDGE_AFTER_COST")!.bps).to.equal(20);
  });

  it("returns a negative edge-after-cost when execution costs exceed gross", () => {
    const w = buildCostWaterfall({ grossBps: 35, costs: baseCosts });
    expect(w.edgeAfterCostBps).to.equal(-25);
  });
});

describe("cost scenarios", () => {
  it("produces base, doubled-costs, and route-failure scenarios", () => {
    const scenarios = buildCostScenarios({ grossBps: 100, baseCosts });
    expect(scenarios.map((s) => s.name)).to.deep.equal([
      "BASE",
      "DOUBLED_COSTS",
      "ROUTE_FAILURE_HAIRCUT",
    ]);
    const doubled = scenarios.find((s) => s.name === "DOUBLED_COSTS")!.waterfall;
    expect(doubled.estimatedExecutionCostBps).to.equal(80);
    const haircut = scenarios.find((s) => s.name === "ROUTE_FAILURE_HAIRCUT")!.waterfall;
    expect(haircut.grossBps).to.equal(95);
  });

  it("honours custom route-failure haircut", () => {
    const scenarios = buildCostScenarios({
      grossBps: 100,
      baseCosts,
      routeFailureHaircutBps: 12,
    });
    const haircut = scenarios.find((s) => s.name === "ROUTE_FAILURE_HAIRCUT")!.waterfall;
    expect(haircut.grossBps).to.equal(88);
  });
});
