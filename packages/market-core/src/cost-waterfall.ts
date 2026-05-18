/** Cost waterfall — name every bp the dashboard subtracts.
 *
 *  The bot's net edge today is:
 *      net_edge_bps = gross_edge_bps
 *                   - slippage_buffer_bps
 *                   - landing_cost_bps
 *                   - failure_buffer_bps
 *                   - min_profit_bps
 *
 *  That's two profit hurdles stacked together (`MIN_PROFIT_BPS` + per-pair
 *  `minNetEdgeBps`), with no surface that explains where each bp went. This
 *  module turns the same arithmetic into a labelled, ordered decomposition the
 *  research dashboard can render as a waterfall.
 *
 *  Cost sensitivity is intentionally limited to scenarios the bot can support
 *  today: base, doubled costs, and a route-failure haircut. Latency-shift and
 *  worse-slippage scenarios require richer per-tick data and are left as
 *  follow-ups. */

export type CostInputsBps = {
  /** Buffer beyond Jupiter's `slippageBps` — covers worst-case fill slippage. */
  slippageBufferBps: number;
  /** Estimated landing cost: priority fee + tip + base fee, expressed in bps. */
  landingCostBps: number;
  /** Reserve for failed-attempt cost (gas spent on a non-landing tx). */
  failureBufferBps: number;
  /** Floor the strategy must clear after every other cost. */
  minProfitBps: number;
};

export type CostStepCode =
  | "GROSS"
  | "SLIPPAGE_BUFFER"
  | "LANDING_COST"
  | "FAILURE_BUFFER"
  | "REQUIRED_PROFIT"
  | "EDGE_AFTER_COST";

export type CostStep = {
  code: CostStepCode;
  label: string;
  bps: number;
};

export type CostWaterfall = {
  grossBps: number;
  estimatedExecutionCostBps: number;
  requiredProfitBps: number;
  entryThresholdBps: number;
  edgeAfterCostBps: number;
  steps: CostStep[];
};

export function buildCostWaterfall(args: {
  grossBps: number;
  costs: CostInputsBps;
}): CostWaterfall {
  const { grossBps, costs } = args;
  const estimatedExecutionCostBps =
    costs.slippageBufferBps + costs.landingCostBps + costs.failureBufferBps;
  const entryThresholdBps = estimatedExecutionCostBps + costs.minProfitBps;
  const edgeAfterCostBps = grossBps - entryThresholdBps;

  return {
    grossBps,
    estimatedExecutionCostBps,
    requiredProfitBps: costs.minProfitBps,
    entryThresholdBps,
    edgeAfterCostBps,
    steps: [
      { code: "GROSS", label: "Gross edge", bps: grossBps },
      { code: "SLIPPAGE_BUFFER", label: "Slippage buffer", bps: -costs.slippageBufferBps },
      { code: "LANDING_COST", label: "Landing cost", bps: -costs.landingCostBps },
      { code: "FAILURE_BUFFER", label: "Failure buffer", bps: -costs.failureBufferBps },
      { code: "REQUIRED_PROFIT", label: "Required profit", bps: -costs.minProfitBps },
      { code: "EDGE_AFTER_COST", label: "Edge after cost", bps: edgeAfterCostBps },
    ],
  };
}

export type CostScenarioName = "BASE" | "DOUBLED_COSTS" | "ROUTE_FAILURE_HAIRCUT";

export type CostScenario = {
  name: CostScenarioName;
  label: string;
  description: string;
  waterfall: CostWaterfall;
};

/** Build the three scenarios the dashboard renders side-by-side. */
export function buildCostScenarios(args: {
  grossBps: number;
  baseCosts: CostInputsBps;
  /** Bps debited additionally to model an occasional landed-but-zero-edge
   *  failure. Default 5 bps — small but not zero. */
  routeFailureHaircutBps?: number;
}): CostScenario[] {
  const { grossBps, baseCosts } = args;
  const routeFailureHaircutBps = args.routeFailureHaircutBps ?? 5;
  return [
    {
      name: "BASE",
      label: "Base",
      description: "Configured cost assumptions",
      waterfall: buildCostWaterfall({ grossBps, costs: baseCosts }),
    },
    {
      name: "DOUBLED_COSTS",
      label: "Doubled costs",
      description: "All execution costs doubled to model adverse Solana conditions",
      waterfall: buildCostWaterfall({
        grossBps,
        costs: {
          slippageBufferBps: baseCosts.slippageBufferBps * 2,
          landingCostBps: baseCosts.landingCostBps * 2,
          failureBufferBps: baseCosts.failureBufferBps * 2,
          minProfitBps: baseCosts.minProfitBps,
        },
      }),
    },
    {
      name: "ROUTE_FAILURE_HAIRCUT",
      label: "Route-failure haircut",
      description: `${routeFailureHaircutBps} bps haircut for an occasional route or maker flip`,
      waterfall: buildCostWaterfall({
        grossBps: grossBps - routeFailureHaircutBps,
        costs: baseCosts,
      }),
    },
  ];
}
