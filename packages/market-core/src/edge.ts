/** Positive means the tokenized asset trades BELOW Pyth — we can buy it
 *  cheap and (in theory) sell at the Pyth-referenced price elsewhere.
 *  Formula from the spec: (base / token_buy - 1) * 10000. */
export function buyEdgeBps(args: { basePriceUsd: number; tokenBuyPriceUsd: number }): number {
  if (args.basePriceUsd <= 0 || args.tokenBuyPriceUsd <= 0) throw new Error("non-positive price");
  return (args.basePriceUsd / args.tokenBuyPriceUsd - 1) * 10000;
}

/** Positive means the tokenized asset trades ABOVE Pyth — we can sell it
 *  rich and (in theory) buy back at the Pyth-referenced price.
 *  Formula from the spec: (token_sell / base - 1) * 10000. */
export function sellEdgeBps(args: { basePriceUsd: number; tokenSellPriceUsd: number }): number {
  if (args.basePriceUsd <= 0 || args.tokenSellPriceUsd <= 0) throw new Error("non-positive price");
  return (args.tokenSellPriceUsd / args.basePriceUsd - 1) * 10000;
}
