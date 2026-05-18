/** Canonical onchain/underlying orientation.
 *
 *  Every research surface should read like `WBTC/BTC`, `AAPLx/AAPL`, `XAUt0/XAU`
 *  — the tokenized (executable on Solana) asset first, the off-chain reference
 *  second. The display ratio answers a single research question:
 *
 *      onchain_underlying_ratio = executable_onchain_price_usd / underlying_reference_price_usd
 *
 *  Negative `displayBasisBps` → onchain trades cheap (potential buy-tokenized).
 *  Positive `displayBasisBps` → onchain trades rich (potential sell-tokenized,
 *  only meaningful with prior spot inventory). */

import type { PairConfig } from "./pair-config";

export type DisplayBasisInterpretation =
  | "ONCHAIN_CHEAP"
  | "AT_PARITY"
  | "ONCHAIN_RICH";

/** Default tolerance for "at parity". 5 bps ~= 0.05% — tighter than any
 *  realistic Solana execution cost, so a row inside this band tells the
 *  researcher there is no directional opportunity worth pursuing. */
export const DEFAULT_PARITY_TOLERANCE_BPS = 5;

/** Derive the underlying reference symbol from a Pyth Lazer symbol such as
 *  `Crypto.BTC/USD`, `Equity.US.AAPL/USD`, or `Metal.XAU/USD`. Returns the
 *  empty string only if the input is malformed. */
export function underlyingSymbolFromPythSymbol(pythSymbol: string): string {
  const trimmed = pythSymbol.trim();
  if (trimmed.length === 0) return "";
  const slashIdx = trimmed.lastIndexOf("/");
  const left = slashIdx >= 0 ? trimmed.slice(0, slashIdx) : trimmed;
  const dotIdx = left.lastIndexOf(".");
  return dotIdx >= 0 ? left.slice(dotIdx + 1) : left;
}

/** Canonical `onchain/underlying` label, derived from pair config. Falls back
 *  to the operator-supplied label if the Pyth symbol is empty (test fixtures
 *  occasionally omit it). */
export function pairDisplayLabel(pair: PairConfig): string {
  const underlying = underlyingSymbolFromPythSymbol(pair.base.pythSymbol);
  if (underlying.length === 0) return pair.label;
  return `${pair.tokenized.symbol}/${underlying}`;
}

/** Subtitle for the ratio shown in cards/charts, e.g. `WBTC/BTC ratio`. */
export function pairRatioLabel(pair: PairConfig): string {
  return `${pairDisplayLabel(pair)} ratio`;
}

/** `tokenPriceUsd / basePriceUsd`. Returns null when either price is missing
 *  or non-positive — display layers must show "—" rather than 0×. */
export function displayRatio(
  tokenPriceUsd: number | null | undefined,
  basePriceUsd: number | null | undefined,
): number | null {
  if (
    tokenPriceUsd == null ||
    basePriceUsd == null ||
    !Number.isFinite(tokenPriceUsd) ||
    !Number.isFinite(basePriceUsd) ||
    tokenPriceUsd <= 0 ||
    basePriceUsd <= 0
  ) {
    return null;
  }
  return tokenPriceUsd / basePriceUsd;
}

/** Display basis in basis points, with the canonical orientation:
 *      bps > 0 → onchain rich
 *      bps < 0 → onchain cheap. */
export function displayBasisBps(ratio: number | null): number | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  return (ratio - 1) * 10_000;
}

export function interpretDisplayBasisBps(
  bps: number | null,
  toleranceBps: number = DEFAULT_PARITY_TOLERANCE_BPS,
): DisplayBasisInterpretation | null {
  if (bps == null || !Number.isFinite(bps)) return null;
  if (Math.abs(bps) <= toleranceBps) return "AT_PARITY";
  return bps < 0 ? "ONCHAIN_CHEAP" : "ONCHAIN_RICH";
}

export type DisplayBasis = {
  ratio: number | null;
  basisBps: number | null;
  interpretation: DisplayBasisInterpretation | null;
};

/** Convenience: compute the ratio, bps, and interpretation in one call. */
export function describeDisplayBasis(args: {
  tokenPriceUsd: number | null | undefined;
  basePriceUsd: number | null | undefined;
  parityToleranceBps?: number;
}): DisplayBasis {
  const ratio = displayRatio(args.tokenPriceUsd, args.basePriceUsd);
  const basisBps = displayBasisBps(ratio);
  return {
    ratio,
    basisBps,
    interpretation: interpretDisplayBasisBps(
      basisBps,
      args.parityToleranceBps ?? DEFAULT_PARITY_TOLERANCE_BPS,
    ),
  };
}
