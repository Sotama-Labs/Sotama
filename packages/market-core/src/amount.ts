/** Convert a UI amount to atomic units using banker's rounding (round-half-to-even).
 *  Plain Math.round would round half-up, biasing reported volumes upward — small
 *  effect per quote, large effect over millions of quotes/day. */
export function uiToAtomic(ui: number, decimals: number): bigint {
  if (!Number.isFinite(ui) || ui < 0) throw new Error(`bad amount: ${ui}`);
  const scaled = ui * Math.pow(10, decimals);
  const rounded = bankersRound(scaled);
  return BigInt(rounded);
}

export function atomicToUi(atomic: bigint, decimals: number): number {
  return Number(atomic) / Math.pow(10, decimals);
}

/** Round half-to-even. Ties go toward the nearest even integer. */
function bankersRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  // exact .5 → toward even
  return floor % 2 === 0 ? floor : floor + 1;
}

/** USD notional → input-side atomic units, given the input mint's USD price and decimals. */
export function usdToInputAtomic(usd: number, priceUsd: number, decimals: number): bigint {
  if (priceUsd <= 0) throw new Error("priceUsd must be > 0");
  return uiToAtomic(usd / priceUsd, decimals);
}
