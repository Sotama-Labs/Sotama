import { z } from "zod";

/** Jupiter Pro endpoint. Free tier lives at `lite-api.jup.ag` and ignores
 *  the API key; paid tier requires it and rate-limits a much higher RPS. */
const JUPITER_PRO_URL = "https://api.jup.ag";
const JUPITER_LITE_URL = "https://lite-api.jup.ag";

export const BotConfigSchema = z.object({
  DATABASE_URL: z.string().url(),

  // ── Pyth Lazer ────────────────────────────────────────────────────
  PYTH_CHANNEL: z.string().default("fixed_rate@1000ms"),
  PYTH_LAZER_ACCESS_TOKEN: z.string().min(1),
  PYTH_MAX_FRESHNESS_LAG_MS: z.coerce.number().int().min(0).default(5_000),

  // ── Jupiter Pro ───────────────────────────────────────────────────
  /** When unset, derived from `JUPITER_API_KEY`: paid URL if a key is
   *  present, lite URL otherwise. Override explicitly to force a tier. */
  JUPITER_BASE_URL: z.string().url().optional(),
  JUPITER_API_KEY: z.string().min(1).optional(),
  JUPITER_MAX_RPS: z.coerce.number().default(9),
  JUPITER_SUCCESS_RAW_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.02),

  // ── Helius RPC ────────────────────────────────────────────────────
  /** Full Helius RPC URL with API key baked in, e.g.
   *  `https://mainnet.helius-rpc.com/?api-key=xxx`. Optional in V1 (the
   *  bot does not yet hit Solana RPC — Pyth Lazer + Jupiter HTTP cover
   *  prices and quotes), but kept on the config surface so pair-creation
   *  validation can use it as soon as we add it. */
  HELIUS_RPC_URL: z.string().url().optional(),
  /** Helius WebSocket endpoint, e.g. `wss://mainnet.helius-rpc.com/?api-key=xxx`.
   *  Same future-use disclaimer as HELIUS_RPC_URL. */
  HELIUS_WS_URL: z.string().url().optional(),

  // ── HTTP read API ─────────────────────────────────────────────────
  /** Port the bot's public read API listens on. Fly's [http_service] in
   *  fly.toml maps the public 443 to this internal port. */
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** CORS allow-origin for the read API. Default `*` matches V1's
   *  unauthenticated read-only data. */
  API_CORS_ORIGIN: z.string().default("*"),

  // ── Cadence ────────────────────────────────────────────────────────
  PAIR_REFRESH_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(5_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Classify crypto observations as CRYPTO_HIGH_VOL when the current Pyth
   *  tick has moved this many bps from the previous tick seen for the pair. */
  CRYPTO_HIGH_VOL_MOVE_BPS: z.coerce.number().min(0).default(50),

  // ── Cost-model assumptions, all in bps. Tunable per environment. ──
  SLIPPAGE_BUFFER_BPS: z.coerce.number().default(30),
  LANDING_COST_BPS: z.coerce.number().default(5),
  FAILURE_BUFFER_BPS: z.coerce.number().default(5),
  MIN_PROFIT_BPS: z.coerce.number().default(20),
});

export type BotConfig = z.infer<typeof BotConfigSchema> & {
  /** Resolved Jupiter base URL after applying paid-vs-lite logic. */
  readonly jupiterBaseUrl: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = BotConfigSchema.parse(env);
  const jupiterBaseUrl =
    parsed.JUPITER_BASE_URL ??
    (parsed.JUPITER_API_KEY ? JUPITER_PRO_URL : JUPITER_LITE_URL);
  return { ...parsed, jupiterBaseUrl };
}
