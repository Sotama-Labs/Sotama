use anyhow::{anyhow, Context, Result};
use solana_sdk::pubkey::Pubkey;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use crate::signer::{load_signer, KeeperSigner};

/// Controls whether the streaming price paths (Hermes SSE, Lazer) are
/// authoritative or run in parallel for comparison only.
///
/// - `Off` (default): only the legacy 12s Hermes poll drives the live
///   price cache. Streaming SSE subscriber runs but writes to a separate
///   shadow cache that nothing reads (prepared for Task 22's comparator).
/// - `Shadow`: same as Off — legacy poll is authoritative — but the
///   comparator (Task 22) is active and diffs the two caches.
/// - `On`: streaming SSE is authoritative; the legacy 12s Hermes poll
///   task is suppressed. Lazer always writes to the live cache regardless
///   of mode (sub-second source, no conflict with poll suppression).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamMode {
    Off,
    Shadow,
    On,
}

impl StreamMode {
    pub fn from_env() -> Self {
        match std::env::var("KEEPER_STREAM_MODE")
            .ok()
            .as_deref()
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("on") => Self::On,
            Some("shadow") => Self::Shadow,
            _ => Self::Off,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cluster {
    Devnet,
    MainnetBeta,
}

impl Cluster {
    pub fn from_env() -> Self {
        match std::env::var("CLUSTER").ok().as_deref() {
            Some("mainnet-beta") | Some("mainnet") => Cluster::MainnetBeta,
            _ => Cluster::Devnet,
        }
    }

    pub fn is_mainnet(&self) -> bool {
        matches!(self, Cluster::MainnetBeta)
    }

    pub fn label(&self) -> &'static str {
        match self {
            Cluster::Devnet => "devnet",
            Cluster::MainnetBeta => "mainnet-beta",
        }
    }
}

pub struct KeeperConfig {
    pub cluster: Cluster,
    pub api_key: String,
    pub rpc_url: String,
    pub ws_url: String,
    pub sender_url: String,
    pub hermes_url: String,
    pub jupiter_base_url: String,
    pub signer: Arc<dyn KeeperSigner>,
    pub keeper_pubkey: Pubkey,
    pub program_id: Pubkey,
    pub reconcile_interval: Duration,
    pub price_poll_interval: Duration,
    pub fee_topup_scan_interval: Duration,
    /// Tick interval for `time_watcher`. Coarser than the price loop
    /// because TimeElapsed triggers are minute-resolution at finest.
    /// 60s is plenty for "5 minutes from now" semantics — the user
    /// won't notice ±30s drift on a 1-hour timer.
    pub time_watcher_interval: Duration,
    /// Tick interval for `bridge_dispatcher`. Defaults to 30s — the
    /// dispatcher's job is "convert stuck arb output back into the input
    /// mint so the next fire has buying power," and a couple of misses
    /// at 30s only delay the next fire by a few ticks.
    pub bridge_scan_interval: Duration,
    /// Per-mint dust threshold below which the dispatcher ignores a
    /// stuck balance. Avoids paying gas on swaps whose output covers
    /// less than the swap fees themselves. 100k base units is roughly
    /// $0.10 of USDC (6 decimals) — a sensible floor.
    pub bridge_min_balance: u64,
    /// Slippage budget the dispatcher applies on top of Jupiter's quote
    /// when computing `min_amount_out` for `execute_bridge`. The
    /// on-chain handler enforces the floor; if the route worsens
    /// between quote and CPI, the tx reverts.
    pub bridge_slippage_bps: u16,
    pub shard_size: usize,
    pub swap_slippage_bps: u16,
    pub keeper_fee_lamports: u64,
    pub fee_topup_threshold_lamports: u64,
    pub fee_topup_amount_lamports: u64,
    /// Optional Pyth Lazer access token. When set, the keeper opens a
    /// sub-second WebSocket stream to Lazer for `AssetPrice` triggers
    /// and runs ALONGSIDE the existing Hermes polling watcher.
    /// Whichever fires first wins; the executor's dedupe layer drops
    /// the duplicate. When the token expires or is unset, the Hermes
    /// path keeps running unchanged at its 12s cadence.
    pub lazer_access_token: Option<String>,
    /// When true (default), the keeper polls Jupiter Price API v3 for
    /// AssetPrice triggers with `source = oracle_source::JUPITER`. Tokens
    /// without a Pyth feed go through this path. Disable by setting
    /// `JUPITER_PRICE_ENABLED=0` (testing or rate-limit recovery).
    pub jupiter_price_enabled: bool,
    /// Jupiter Price API v3 endpoint. The keeper hits
    /// `<jupiter_price_url>?ids=<mint1>,<mint2>,…`. Hot-swap point: a
    /// future provider (Pyth pull v3, Switchboard, …) drops in here.
    pub jupiter_price_url: String,
    /// Optional Jupiter Pro API key. Sent as `x-api-key` on all Jupiter
    /// calls (price + swap). Free tier ignores it; Pro tier (api.jup.ag)
    /// requires it for higher rate limits.
    pub jupiter_api_key: Option<String>,
    /// Floor priority fee in microlamports per compute unit, used by the
    /// executor when the priority-fee cache is empty (cold start) and as
    /// the baseline for p95 escalation on retryable send failures.
    /// Env: KEEPER_PRIORITY_FEE_FLOOR. Default 50_000.
    pub priority_fee_floor: u64,
    /// Ceiling on the per-tx priority fee in microlamports per compute
    /// unit. Caps a runaway `getPriorityFeeEstimate` spike (we've seen
    /// Helius briefly return multi-SOL/CU under abusive on-chain
    /// conditions) so a single landing can't drain operating SOL. Sits
    /// well above any realistic congestion fee but inside the SOL
    /// budget — at the default 1_000_000 and CU limit 1M, max cost is
    /// 0.001 SOL per swap tx. Env: KEEPER_PRIORITY_FEE_CEILING.
    pub priority_fee_ceiling: u64,
    /// Compute-unit limit for `execute_swap` relays. The Jupiter route
    /// dominates; deep routes (3-4 AMM hops) burn 600-900k CU. Static
    /// over-pay until we wire `simulateTransaction` to size per-tx.
    /// Env: KEEPER_CU_LIMIT_SWAP. Default 800_000.
    pub cu_limit_swap: u32,
    /// Compute-unit limit for `execute_bridge`. Same shape as swap but
    /// no downstream-deposit branch, so ~100k CU cheaper. Env:
    /// KEEPER_CU_LIMIT_BRIDGE. Default 700_000.
    pub cu_limit_bridge: u32,
    /// Compute-unit limit for non-swap actions (TransferSol,
    /// TransferSpl). Anchor handlers are small; 200k is plenty. Env:
    /// KEEPER_CU_LIMIT_DEFAULT.
    pub cu_limit_default: u32,
    /// Streaming price path mode. See [`StreamMode`] for semantics.
    /// Env: KEEPER_STREAM_MODE (off | shadow | on). Default: off.
    pub stream_mode: StreamMode,
    /// Optional path for persisting the FillCache to disk. When set the
    /// cache survives keeper restarts (redeploy, crash, host migration).
    /// Env: KEEPER_FILL_CACHE_PATH. Default: None (in-memory only).
    pub fill_cache_path: Option<PathBuf>,
    /// Opt-in for Helius Sender dual-routing (validators + Jito).
    /// When true, the executor and bridge dispatcher append a Jito tip
    /// ix (0.0002 SOL minimum) and post to `sender.helius-rpc.com/fast`
    /// with `skipPreflight: true, maxRetries: 0` (per Helius docs,
    /// 2026-02-27 spec). Sender gives 50 TPS at 0 credits/tx, dual-
    /// routes to validators + Jito for max inclusion. Off by default
    /// because Sender requires the tip — we charge it from the
    /// keeper's operating SOL, and operators want to enable it
    /// deliberately. Env: KEEPER_USE_SENDER.
    pub use_sender: bool,
    /// Jito tip in lamports when Sender is enabled. 0.0002 SOL = 200_000
    /// lamports is the minimum per Helius docs; raise for competitive
    /// landing during MEV-heavy windows. Env: KEEPER_SENDER_TIP_LAMPORTS.
    pub sender_tip_lamports: u64,
    /// Helius Sender regional endpoint preference. When set, the keeper
    /// uses `https://{region}-sender.helius-rpc.com/fast` instead of
    /// the global frontend hostname — lower latency for backend-only
    /// senders. Valid regions per Helius docs (2026-02-27): slc, ewr,
    /// lon, fra, ams, sg, tyo. Env: KEEPER_SENDER_REGION. Auto-detects
    /// from `FLY_REGION` when unset; falls back to the global hostname
    /// for unknown regions.
    pub sender_region: Option<String>,
}

impl KeeperConfig {
    pub fn from_env() -> Result<Self> {
        let cluster = Cluster::from_env();

        let (default_rpc, default_ws, default_sender) = match cluster {
            Cluster::Devnet => (
                "https://devnet.helius-rpc.com",
                "wss://atlas-devnet.helius-rpc.com",
                "https://devnet.helius-rpc.com/?api-key=__APIKEY__",
            ),
            Cluster::MainnetBeta => (
                "https://mainnet.helius-rpc.com",
                "wss://atlas-mainnet.helius-rpc.com",
                // Helius Sender — canonical hostname is `sender.helius-rpc.com`,
                // NOT `mainnet-sender.helius-rpc.com` (the latter doesn't
                // resolve; verified via dig 2026-05-11). Sender is
                // global with automatic regional routing — there's no
                // per-cluster hostname. Devnet has no Sender equivalent
                // and falls back to the standard devnet RPC.
                "https://sender.helius-rpc.com/fast",
            ),
        };

        let api_key = required("HELIUS_API_KEY")?;
        let rpc_base = required_or(rpc_env_var(cluster), default_rpc)?;
        let ws_base = required_or(ws_env_var(cluster), default_ws)?;
        let sender_url = required_or(sender_env_var(cluster), default_sender)?;
        let hermes_url = required_or("PYTH_HERMES_URL", "https://hermes.pyth.network")?;
        let jupiter_base_url = required_or("JUPITER_BASE_URL", "https://api.jup.ag")?;

        let rpc_url = format!("{}/?api-key={}", rpc_base.trim_end_matches('/'), api_key);
        let ws_url = format!("{}/?api-key={}", ws_base.trim_end_matches('/'), api_key);
        let sender_url = if sender_url.contains("__APIKEY__") {
            sender_url.replace("__APIKEY__", &api_key)
        } else {
            sender_url
        };

        let signer = load_signer()?;
        let keeper_pubkey = signer.pubkey();

        let program_id_str = required("PROGRAM_ID")?;
        let program_id = Pubkey::from_str(&program_id_str)
            .with_context(|| format!("invalid PROGRAM_ID `{program_id_str}`"))?;

        let reconcile_interval = Duration::from_secs(parse_or("RECONCILE_INTERVAL_SECS", 300)?);
        let price_poll_interval = Duration::from_secs(parse_or("PRICE_POLL_INTERVAL_SECS", 12)?);
        let fee_topup_scan_interval =
            Duration::from_secs(parse_or("FEE_TOPUP_SCAN_INTERVAL_SECS", 300)?);
        let time_watcher_interval =
            Duration::from_secs(parse_or("TIME_WATCHER_INTERVAL_SECS", 60)?);
        let bridge_scan_interval =
            Duration::from_secs(parse_or("BRIDGE_SCAN_INTERVAL_SECS", 30)?);
        let bridge_min_balance = parse_or::<u64>("BRIDGE_MIN_BALANCE", 100_000)?;
        let bridge_slippage_bps = parse_or::<u16>("BRIDGE_SLIPPAGE_BPS", 50)?.max(1);
        let shard_size = parse_or::<usize>("SHARD_SIZE", 40)?.max(1);
        let swap_slippage_bps = parse_or::<u16>("SWAP_SLIPPAGE_BPS", 50)?.max(1);
        let keeper_fee_lamports = parse_or::<u64>("KEEPER_FEE_LAMPORTS", 5_000)?;
        let fee_topup_threshold_lamports =
            parse_or::<u64>("FEE_TOPUP_THRESHOLD_LAMPORTS", 50_000)?;
        let fee_topup_amount_lamports =
            parse_or::<u64>("FEE_TOPUP_AMOUNT_LAMPORTS", 100_000)?;

        let lazer_access_token = std::env::var("LAZER_ACCESS_TOKEN")
            .ok()
            .filter(|s| !s.trim().is_empty());

        let jupiter_price_enabled = parse_or::<u8>("JUPITER_PRICE_ENABLED", 1)? != 0;
        let jupiter_api_key = std::env::var("JUPITER_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty());
        // When a Pro key is configured, default the price URL to the
        // paid host (`api.jup.ag`) so the key actually applies. The Lite
        // host ignores the `x-api-key` header — leaving the default at
        // `lite-api.jup.ag` here would silently rate-limit a paid setup.
        let default_price_url = if jupiter_api_key.is_some() {
            "https://api.jup.ag/price/v3"
        } else {
            "https://lite-api.jup.ag/price/v3"
        };
        let jupiter_price_url = required_or("JUPITER_PRICE_URL", default_price_url)?;

        let priority_fee_floor = parse_or::<u64>("KEEPER_PRIORITY_FEE_FLOOR", 50_000)?;
        let priority_fee_ceiling = parse_or::<u64>("KEEPER_PRIORITY_FEE_CEILING", 1_000_000)?;
        // Sanity: ceiling must be >= floor; otherwise the clamp is
        // ill-defined. Misordered values usually mean a typo in env
        // wiring — fail loudly at startup rather than silently
        // misbehave at fire time.
        if priority_fee_ceiling < priority_fee_floor {
            return Err(anyhow!(
                "KEEPER_PRIORITY_FEE_CEILING ({}) < KEEPER_PRIORITY_FEE_FLOOR ({}); refusing to start",
                priority_fee_ceiling,
                priority_fee_floor
            ));
        }
        let cu_limit_swap = parse_or::<u32>("KEEPER_CU_LIMIT_SWAP", 800_000)?;
        let cu_limit_bridge = parse_or::<u32>("KEEPER_CU_LIMIT_BRIDGE", 700_000)?;
        let cu_limit_default = parse_or::<u32>("KEEPER_CU_LIMIT_DEFAULT", 200_000)?;
        let stream_mode = StreamMode::from_env();

        let fill_cache_path = std::env::var("KEEPER_FILL_CACHE_PATH")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from);

        let use_sender = parse_or::<u8>("KEEPER_USE_SENDER", 0)? != 0;
        let sender_tip_lamports = parse_or::<u64>("KEEPER_SENDER_TIP_LAMPORTS", 200_000)?;
        // Per Helius docs (2026-02-27), the min is 0.0002 SOL = 200_000
        // lamports. Refuse to start with a sub-minimum tip — Sender would
        // reject the tx with `-32602 Invalid request` on every send.
        if use_sender && sender_tip_lamports < 200_000 {
            return Err(anyhow!(
                "KEEPER_SENDER_TIP_LAMPORTS ({}) is below Helius Sender's required minimum (200_000 = 0.0002 SOL)",
                sender_tip_lamports
            ));
        }
        // Region preference: explicit env wins, else honour FLY_REGION
        // when it matches a Sender region. Anything else stays None
        // (use the global frontend hostname).
        let valid_sender_regions = ["slc", "ewr", "lon", "fra", "ams", "sg", "tyo"];
        let sender_region = std::env::var("KEEPER_SENDER_REGION")
            .ok()
            .or_else(|| std::env::var("FLY_REGION").ok())
            .map(|s| s.trim().to_lowercase())
            .filter(|s| valid_sender_regions.contains(&s.as_str()));

        Ok(Self {
            cluster,
            api_key,
            rpc_url,
            ws_url,
            sender_url,
            hermes_url,
            jupiter_base_url,
            signer,
            keeper_pubkey,
            program_id,
            reconcile_interval,
            price_poll_interval,
            fee_topup_scan_interval,
            time_watcher_interval,
            bridge_scan_interval,
            bridge_min_balance,
            bridge_slippage_bps,
            shard_size,
            swap_slippage_bps,
            keeper_fee_lamports,
            fee_topup_threshold_lamports,
            fee_topup_amount_lamports,
            lazer_access_token,
            jupiter_price_enabled,
            jupiter_price_url,
            jupiter_api_key,
            priority_fee_floor,
            priority_fee_ceiling,
            cu_limit_swap,
            cu_limit_bridge,
            cu_limit_default,
            stream_mode,
            fill_cache_path,
            use_sender,
            sender_tip_lamports,
            sender_region,
        })
    }
}

fn rpc_env_var(cluster: Cluster) -> &'static str {
    match cluster {
        Cluster::Devnet => "HELIUS_DEVNET_RPC",
        Cluster::MainnetBeta => "HELIUS_MAINNET_RPC",
    }
}

fn ws_env_var(cluster: Cluster) -> &'static str {
    match cluster {
        Cluster::Devnet => "HELIUS_DEVNET_WS",
        Cluster::MainnetBeta => "HELIUS_MAINNET_WS",
    }
}

fn sender_env_var(cluster: Cluster) -> &'static str {
    match cluster {
        Cluster::Devnet => "HELIUS_DEVNET_SENDER",
        Cluster::MainnetBeta => "HELIUS_MAINNET_SENDER",
    }
}

fn required(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| anyhow!("missing required env var {name}"))
}

fn required_or(name: &str, default: &str) -> Result<String> {
    Ok(std::env::var(name).unwrap_or_else(|_| default.to_string()))
}

fn parse_or<T: FromStr>(name: &str, default: T) -> Result<T>
where
    <T as FromStr>::Err: std::fmt::Display,
{
    match std::env::var(name) {
        Ok(v) => v
            .parse::<T>()
            .map_err(|e| anyhow!("invalid {name}={v}: {e}")),
        Err(_) => Ok(default),
    }
}
