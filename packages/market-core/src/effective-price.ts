import { atomicToUi } from "./amount";

/** Effective USD price per unit of tokenized asset, BUY side.
 *  inUsd: USD we spent (e.g. $100 of USDC, which is the input).
 *  outAtomic / outDecimals: tokenized output we got back. */
export function effectiveBuyPriceUsd(args: {
  inUsd: number;
  outAtomic: bigint;
  outDecimals: number;
}): number {
  const outUi = atomicToUi(args.outAtomic, args.outDecimals);
  if (outUi <= 0) throw new Error("zero out");
  return args.inUsd / outUi;
}

/** Effective USD price per unit of tokenized asset, SELL side.
 *  inAtomic / inDecimals: tokenized we sold.
 *  outUsdAtomic / outUsdDecimals: USDC we received (decimals=6 in practice). */
export function effectiveSellPriceUsd(args: {
  inAtomic: bigint;
  inDecimals: number;
  outUsdAtomic: bigint;
  outUsdDecimals: number;
}): number {
  const inUi = atomicToUi(args.inAtomic, args.inDecimals);
  const outUsd = atomicToUi(args.outUsdAtomic, args.outUsdDecimals);
  if (inUi <= 0) throw new Error("zero in");
  return outUsd / inUi;
}
