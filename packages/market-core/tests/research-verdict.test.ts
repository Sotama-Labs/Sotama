import { expect } from "chai";
import {
  buildResearchVerdict,
  type ResearchVerdictInputs,
  type TokenValidationSnapshot,
} from "../src/research-verdict";
import type { PairConfig } from "../src/pair-config";
import type { PairReadinessMatrix } from "../src/pair-readiness";
import type { HoldHorizonReplayRow } from "../src/hold-horizon";
import type { PairStatSummary } from "../src/stat-summary";
import type { RouteStabilitySummary } from "../src/route-stability";

const pair: PairConfig = {
  id: "wbtc-btc",
  enabled: true,
  label: "WBTC/BTC",
  base: { pythSymbol: "Crypto.BTC/USD", pythLazerId: 1, exponent: -8, assetClass: "Crypto" },
  tokenized: { mint: "x".repeat(43), symbol: "WBTC", decimals: 8 },
  quote: { mint: "y".repeat(44), symbol: "USDC", decimals: 6 },
  sizesUsd: [250, 1000],
  directions: ["buy_tokenized", "sell_tokenized"],
  quoteIntervalMs: 1000,
  minPriceMoveBps: 1,
  slippageBps: 30,
  minNetEdgeBps: 20,
};

const tokenValid: TokenValidationSnapshot = {
  status: "VERIFIED_ONCHAIN",
  mint: pair.tokenized.mint,
  decimals: pair.tokenized.decimals,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  reason: "mint verified",
};

const tokenUnverified: TokenValidationSnapshot = {
  status: "DECIMALS_CONFIG_ONLY",
  mint: pair.tokenized.mint,
  decimals: pair.tokenized.decimals,
  tokenProgram: null,
  reason: "config-only decimals; mint not fetched from chain yet",
};

const stableRoute: RouteStabilitySummary = {
  windowMs: 3_600_000,
  totalSampleCount: 100,
  totalOkCount: 95,
  overallSuccessRate: 0.95,
  topRouter: { router: "jupiterz", count: 90, pct: 0.9 },
  routerChangesPerHour: 1,
  routeStable: true,
  perSideSize: [],
};

const unstableRoute: RouteStabilitySummary = {
  ...stableRoute,
  topRouter: { router: "jupiterz", count: 50, pct: 0.5 },
  routerChangesPerHour: 12,
  routeStable: false,
};

function readinessMatrix(status: PairReadinessMatrix["status"]): PairReadinessMatrix {
  return {
    status,
    rows: [
      {
        pairId: pair.id,
        side: "buy_tokenized",
        sizeUsd: 250,
        status,
        reasonCodes: status === "NOT_READY" ? ["SELL_ROUTE_MISSING"] : [],
        sampleCount: 10,
        liveEligibleCount: 10,
        quoteSuccessRate: 1,
        oppositeSideLiveCount: 10,
        routerDistribution: [],
        quoteLatencyMs: { p50: 200, p95: 300, p99: 400 },
        basisAgeMs: { p50: 200, p95: 300, p99: 400 },
        checks: [],
      },
    ],
  };
}

function statSummary(samples: number): PairStatSummary {
  return {
    windowMs: 24 * 3600 * 1000,
    side: "buy_tokenized",
    sizeUsd: 250,
    liveSampleCount: samples,
    fairRatio: 0.99,
    currentRatio: 0.985,
    currentDeviationBps: -50,
    meanRatio: 0.99,
    medianRatio: 0.99,
    ratioMad: 0.001,
    meanDeviationBps: 0,
    medianDeviationBps: 0,
    deviationQuantilesBps: { p01: -100, p05: -80, p10: -60, p50: 0, p90: 60, p95: 80, p99: 100 },
    currentZScore: -1.2,
    robustZScore: -1.4,
    basisVolBps: 40,
    skewBps: 5,
    cheapTailCount: 4,
    richTailCount: 3,
    halfLifeSeconds: 600,
    opportunityCount: 7,
    avgOpportunityDurationSeconds: 90,
    regimeBreakdown: [],
  };
}

function horizonRow(args: Partial<HoldHorizonReplayRow>): HoldHorizonReplayRow {
  return {
    horizonMs: 60_000,
    sampleWindowMs: 86_400_000,
    horizonCovered: true,
    pnlUsd: 0,
    closedTrades: 0,
    winningTrades: 0,
    timedOutTrades: 0,
    openPositions: 0,
    deployedUsd: 0,
    returnPct: 0,
    annualizedReturnPct: null,
    avgRatioMoveBps: null,
    winRate: 0,
    avgHoldSeconds: 0,
    sizeResults: [],
    ...args,
  };
}

const baseInput: ResearchVerdictInputs = {
  pair,
  pairReadiness: readinessMatrix("READY"),
  qualityDistribution: [
    { qualityStatus: "LIVE_ELIGIBLE", observationCount: 500, observationPct: 0.8 },
    { qualityStatus: "STALE_PYTH", observationCount: 125, observationPct: 0.2 },
  ],
  holdHorizonReplay: [
    horizonRow({ closedTrades: 30, winningTrades: 22, pnlUsd: 50, returnPct: 0.005 }),
    horizonRow({ horizonMs: 5 * 60_000, closedTrades: 25, winningTrades: 18, pnlUsd: 40, returnPct: 0.004 }),
  ],
  statSummary: [statSummary(500)],
  routeStability: stableRoute,
  tokenValidation: tokenValid,
  costScenarioName: "BASE",
  cleanWindowMs: 24 * 3600 * 1000,
  minCleanSamples: 200,
  candidateMinClosedTrades: 30,
  candidateMinPositiveHorizons: 2,
};

describe("research verdict", () => {
  it("reports paused pairs before feed or route readiness failures", () => {
    const verdict = buildResearchVerdict({
      ...baseInput,
      pair: { ...pair, enabled: false },
      pairReadiness: readinessMatrix("NOT_READY"),
    });
    expect(verdict.status).to.equal("NOT_READY");
    expect(verdict.summary).to.contain("paused");
    expect(verdict.blockers.map((b) => b.code)).to.deep.equal(["PAIR_DISABLED"]);
  });

  it("returns NOT_READY when pair readiness is NOT_READY", () => {
    const verdict = buildResearchVerdict({
      ...baseInput,
      pairReadiness: readinessMatrix("NOT_READY"),
    });
    expect(verdict.status).to.equal("NOT_READY");
    expect(verdict.blockers.map((b) => b.code)).to.include("PAIR_READINESS_NOT_READY");
  });

  it("returns COLLECT_MORE when live samples are below threshold", () => {
    const verdict = buildResearchVerdict({
      ...baseInput,
      qualityDistribution: [
        { qualityStatus: "LIVE_ELIGIBLE", observationCount: 50, observationPct: 0.5 },
      ],
    });
    expect(verdict.status).to.equal("COLLECT_MORE");
    expect(verdict.summary).to.contain("50 live-eligible samples");
  });

  it("returns NO_EDGE when replay produces no positive horizon", () => {
    const verdict = buildResearchVerdict({
      ...baseInput,
      holdHorizonReplay: [
        horizonRow({ closedTrades: 5, winningTrades: 0, returnPct: -0.001, pnlUsd: -10 }),
      ],
    });
    expect(verdict.status).to.equal("NO_EDGE");
  });

  it("returns PAPER_EDGE when replay is positive but coverage is thin", () => {
    const verdict = buildResearchVerdict({
      ...baseInput,
      holdHorizonReplay: [
        horizonRow({ closedTrades: 5, winningTrades: 4, returnPct: 0.001, pnlUsd: 20 }),
      ],
    });
    expect(verdict.status).to.equal("PAPER_EDGE");
  });

  it("returns CANDIDATE when readiness, route stability, and replay all clear", () => {
    const verdict = buildResearchVerdict(baseInput);
    expect(verdict.status).to.equal("CANDIDATE");
    expect(verdict.positives.map((p) => p.code)).to.include("PAIR_READINESS_READY");
  });

  it("flags an unverified mint as a blocker but not a critical one", () => {
    const verdict = buildResearchVerdict({
      ...baseInput,
      tokenValidation: tokenUnverified,
    });
    expect(verdict.blockers.map((b) => b.code)).to.include("TOKEN_MINT_UNVERIFIED");
    expect(verdict.status).to.equal("CANDIDATE");
  });

  it("downgrades to PAPER_EDGE when route stability is missing", () => {
    const verdict = buildResearchVerdict({
      ...baseInput,
      routeStability: unstableRoute,
    });
    expect(verdict.blockers.map((b) => b.code)).to.include("ROUTE_UNSTABLE");
    expect(["PAPER_EDGE", "CANDIDATE"]).to.include(verdict.status);
    if (verdict.status === "CANDIDATE") {
      // shouldn't happen, but assert that route was at least flagged
      expect.fail("expected CANDIDATE to be blocked by route instability");
    }
  });
});
