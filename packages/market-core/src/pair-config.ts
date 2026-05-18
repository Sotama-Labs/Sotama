import { z } from "zod";

export const ACTIVE_QUOTE_SIZES_USD = [250, 1000] as const;

const AssetClassEnum = z.enum(["Crypto", "Equity", "Commodity", "FX", "Metal"]);
const DirectionEnum = z.enum(["buy_tokenized", "sell_tokenized"]);
const ActiveQuoteSizeEnum = z.union([z.literal(250), z.literal(1000)]);

export const PairConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  label: z.string().min(1),
  base: z.object({
    pythSymbol: z.string().min(1),
    pythLazerId: z.number().int().nonnegative(),
    exponent: z.number().int(),
    assetClass: AssetClassEnum,
    maxPythFreshnessLagMs: z.number().int().nonnegative().optional(),
  }),
  tokenized: z.object({
    mint: z.string().min(32).max(64),
    symbol: z.string().min(1),
    decimals: z.number().int().min(0).max(18),
    logo: z.string().url().optional(),
  }),
  quote: z.object({
    mint: z.string().min(32).max(64),
    symbol: z.literal("USDC"),
    decimals: z.literal(6),
  }),
  sizesUsd: z.array(ActiveQuoteSizeEnum).min(1).max(ACTIVE_QUOTE_SIZES_USD.length),
  directions: z.array(DirectionEnum).min(1),
  quoteIntervalMs: z.number().int().min(500),
  minPriceMoveBps: z.number().nonnegative(),
  slippageBps: z.number().nonnegative(),
  minNetEdgeBps: z.number().nonnegative(),
});

export type PairConfig = z.infer<typeof PairConfigSchema>;
export type PairDirection = z.infer<typeof DirectionEnum>;

export function normalizeActiveQuoteSizes(sizesUsd: readonly number[]): number[] {
  return ACTIVE_QUOTE_SIZES_USD.filter((size) => sizesUsd.includes(size));
}
