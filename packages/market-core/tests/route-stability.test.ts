import { expect } from "chai";
import {
  buildRouteStability,
  type RouteStabilityQuoteRow,
} from "../src/route-stability";

function row(args: Partial<RouteStabilityQuoteRow>): RouteStabilityQuoteRow {
  return {
    side: "buy_tokenized",
    sizeUsd: 250,
    receivedAtMs: 0,
    router: "jupiterz",
    status: "ok",
    requestMs: 200,
    priceImpactPct: 0.01,
    expiresAtMs: null,
    contextSlot: null,
    ...args,
  };
}

describe("route stability", () => {
  it("flags a stable route when one router dominates with few switches", () => {
    const rows: RouteStabilityQuoteRow[] = [];
    for (let i = 0; i < 50; i += 1) {
      rows.push(row({ receivedAtMs: i * 30_000 }));
    }
    rows.push(row({ receivedAtMs: 50 * 30_000, router: "phoenix" }));
    const summary = buildRouteStability({
      rows,
      options: { windowMs: 60 * 60 * 1000 },
    });
    expect(summary.routeStable).to.equal(true);
    expect(summary.topRouter?.router).to.equal("jupiterz");
    expect(summary.perSideSize).to.have.length(1);
  });

  it("flags route instability when switches per hour exceed the threshold", () => {
    const rows: RouteStabilityQuoteRow[] = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push(
        row({
          receivedAtMs: i * 60_000,
          router: i % 2 === 0 ? "jupiterz" : "phoenix",
        }),
      );
    }
    const summary = buildRouteStability({
      rows,
      options: { windowMs: 60 * 60 * 1000 },
    });
    expect(summary.routerChangesPerHour).to.be.greaterThan(6);
    expect(summary.routeStable).to.equal(false);
  });

  it("reports per-side and per-size rows separately", () => {
    const rows: RouteStabilityQuoteRow[] = [
      row({ side: "buy_tokenized", sizeUsd: 250 }),
      row({ side: "sell_tokenized", sizeUsd: 250 }),
      row({ side: "buy_tokenized", sizeUsd: 1000 }),
    ];
    const summary = buildRouteStability({
      rows,
      options: { windowMs: 60_000 },
    });
    expect(summary.perSideSize.length).to.equal(3);
  });

  it("computes success rate and latency percentiles only across ok rows", () => {
    const rows: RouteStabilityQuoteRow[] = [
      row({ requestMs: 100, status: "ok" }),
      row({ requestMs: 200, status: "ok" }),
      row({ requestMs: 999, status: "error" }),
    ];
    const summary = buildRouteStability({
      rows,
      options: { windowMs: 60_000 },
    });
    expect(summary.overallSuccessRate).to.be.closeTo(2 / 3, 1e-9);
    const sideRow = summary.perSideSize[0]!;
    expect(sideRow.requestLatencyMs.p50).to.equal(150);
  });
});
