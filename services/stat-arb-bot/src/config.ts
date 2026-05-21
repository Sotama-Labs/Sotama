import { z } from "zod";

/** Jupiter Pro endpoint. Free tier lives at `lite-api.jup.ag` and ignores
 *  the API key; paid tier requires it and rate-limits a much higher RPS. */
const JUPITER_PRO_URL = "https://api.jup.ag";
const JUPITER_LITE_URL = "https://lite-api.jup.ag";

const EnvBoolean = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return value;
}, z.boolean());

export const BotConfigSchema = z.object({
  DATABASE_URL: z.string().url(),

  // ── Pyth Lazer ────────────────────────────────────────────────────
  PYTH_CHANNEL: z.string().default("fixed_rate@1000ms"),
  PYTH_LAZER_ACCESS_TOKEN: z.string().min(1),
  PYTH_MAX_FRESHNESS_LAG_MS: z.coerce.number().int().min(0).default(5_000),
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network"),
  PYTH_LAZER_SYMBOLS_URL: z
    .string()
    .url()
    .default("https://history.pyth-lazer.dourolabs.app/v1/symbols"),
  /** Non-crypto feeds can be silent outside the active reference session.
   *  Poll the latest published Pyth price at low frequency so Jupiter route
   *  diagnostics still run, while quality gates keep stale/off-session rows
   *  out of live signal generation. */
  PYTH_SNAPSHOT_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  PYTH_SNAPSHOT_AFTER_SILENCE_MS: z.coerce.number().int().min(1_000).default(30_000),

  // ── Jupiter Pro ───────────────────────────────────────────────────
  /** When unset, derived from `JUPITER_API_KEY`: paid URL if a key is
   *  present, lite URL otherwise. Override explicitly to force a tier. */
  JUPITER_BASE_URL: z.string().url().optional(),
  JUPITER_API_KEY: z.string().min(1).optional(),
  JUPITER_MAX_RPS: z.coerce.number().default(9),
  JUPITER_SUCCESS_RAW_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.02),

  // ── Helius RPC ────────────────────────────────────────────────────
  /** Full Helius RPC URL with API key baked in, e.g.
   *  `https://mainnet.helius-rpc.com/?api-key=xxx`. Required only for
   *  `TRADE_EXECUTION_MODE=helius-sender`, where the bot fetches lookup
   *  tables and polls signature confirmation. */
  HELIUS_RPC_URL: z.string().url().optional(),
  /** Helius WebSocket endpoint, e.g. `wss://mainnet.helius-rpc.com/?api-key=xxx`.
   *  Reserved for future execution/inventory monitoring. */
  HELIUS_WS_URL: z.string().url().optional(),
  /** Regional Helius Sender endpoint. Fly is currently in ams, so the
   * Amsterdam Sender URL is the default backend endpoint. */
  HELIUS_SENDER_URL: z.string().url().default("http://ams-sender.helius-rpc.com/fast"),
  HELIUS_SENDER_TIP_LAMPORTS: z.coerce.number().int().min(200_000).default(200_000),

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
  SIGNAL_MAX_HOLD_MS: z.coerce.number().int().min(1_000).default(30 * 60_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /** Live trading is opt-in. `paper` keeps today's behavior. `jupiter-dry-run`
   * requests taker-bound transactions but never signs/submits them. */
  TRADE_EXECUTION_MODE: z
    .enum(["paper", "jupiter-dry-run", "jupiter-managed", "helius-sender"])
    .default("paper"),
  TRADE_EXECUTOR_TAKER: z.string().min(32).optional(),
  TRADE_EXECUTOR_PRIVATE_KEY_BS58: z.string().min(1).optional(),
  TRADE_EXECUTION_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(5_000),
  TRADE_EXECUTION_CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
  TRADE_EXECUTION_RETAIN_RAW: EnvBoolean.default(false),
  /** Sender cannot add JupiterZ's market-maker signature via Jupiter
   * `/execute`, so exclude RFQ in Helius Sender mode unless overridden. */
  TRADE_EXECUTION_SENDER_EXCLUDE_ROUTERS: z.string().default("jupiterz"),
  /** Classify crypto observations as CRYPTO_HIGH_VOL when the current Pyth
   *  tick has moved this many bps from the previous tick seen for the pair. */
  CRYPTO_HIGH_VOL_MOVE_BPS: z.coerce.number().min(0).default(50),
  QUALITY_MAX_QUOTE_LATENCY_MS: z.coerce.number().int().min(0).default(1_500),
  QUALITY_MAX_BASIS_AGE_MS: z.coerce.number().int().min(0).default(5_000),
  QUALITY_MAX_PRICE_IMPACT_BPS: z.coerce.number().min(0).default(50),
  QUALITY_MAX_PYTH_CONFIDENCE_BPS: z.coerce.number().min(0).default(25),
  QUALITY_ALLOWED_ROUTERS: z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.split(",").map((s) => s.trim()).filter(Boolean)
        : value,
    z.array(z.string().min(1)).default([]),
  ),

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
  const normalizedEnv = {
    ...env,
    TRADE_EXECUTOR_PRIVATE_KEY_BS58:
      env.TRADE_EXECUTOR_PRIVATE_KEY_BS58 ?? env.BS58_PRIVATE_KEY,
  };
  const parsed = BotConfigSchema.parse(normalizedEnv);
  const jupiterBaseUrl =
    parsed.JUPITER_BASE_URL ??
    (parsed.JUPITER_API_KEY ? JUPITER_PRO_URL : JUPITER_LITE_URL);
  return { ...parsed, jupiterBaseUrl };
}
