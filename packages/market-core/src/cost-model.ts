export type CostInputs = {
  grossBps: number;
  /** Buffer beyond Jupiter's `slippageBps` — covers worst-case fill slippage. */
  slippageBufferBps: number;
  /** Estimated landing cost: priority fee + tip + base fee, expressed in bps of notional. */
  landingCostBps: number;
  /** Reserve for failed-attempt cost (gas spent on a non-landing tx). */
  failureBufferBps: number;
  /** Minimum profit we require after everything else; below this, no signal. */
  minProfitBps: number;
};

export function netEdgeBps(c: CostInputs): number {
  return c.grossBps - c.slippageBufferBps - c.landingCostBps - c.failureBufferBps - c.minProfitBps;
}
