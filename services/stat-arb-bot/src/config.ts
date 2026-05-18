import { z } from "zod";

export const BotConfigSchema = z.object({
  DATABASE_URL: z.string().url(),
  PYTH_CHANNEL: z.string().default("fixed_rate@1000ms"),
  PYTH_LAZER_ACCESS_TOKEN: z.string().min(1),
  JUPITER_BASE_URL: z.string().url().default("https://lite-api.jup.ag"),
  JUPITER_API_KEY: z.string().optional(),
  JUPITER_MAX_RPS: z.coerce.number().default(9),
  PAIR_REFRESH_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(5_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Cost-model assumptions, all in bps. Tunable per environment. */
  SLIPPAGE_BUFFER_BPS: z.coerce.number().default(30),
  LANDING_COST_BPS: z.coerce.number().default(5),
  FAILURE_BUFFER_BPS: z.coerce.number().default(5),
  MIN_PROFIT_BPS: z.coerce.number().default(20),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  return BotConfigSchema.parse(env);
}
