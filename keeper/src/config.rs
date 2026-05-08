use anyhow::{anyhow, Context, Result};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use crate::signer::{load_signer, KeeperSigner};

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
    pub stake_poll_interval: Duration,
    pub fee_topup_scan_interval: Duration,
    pub shard_size: usize,
    pub swap_slippage_bps: u16,
    pub keeper_fee_lamports: u64,
    pub fee_topup_threshold_lamports: u64,
    pub fee_topup_amount_lamports: u64,
    /// Optional Pyth Lazer access token. When set, the keeper opens a
    /// sub-second WebSocket stream to Lazer for `TokenPrice` triggers
    /// and runs ALONGSIDE the existing Hermes polling watcher.
    /// Whichever fires first wins; the executor's dedupe layer drops
    /// the duplicate. When the token expires or is unset, the Hermes
    /// path keeps running unchanged at its 12s cadence.
    pub lazer_access_token: Option<String>,
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
                "https://mainnet-sender.helius-rpc.com/fast",
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

        let reconcile_interval = Duration::from_secs(parse_or("RECONCILE_INTERVAL_SECS", 60)?);
        let price_poll_interval = Duration::from_secs(parse_or("PRICE_POLL_INTERVAL_SECS", 12)?);
        let stake_poll_interval = Duration::from_secs(parse_or("STAKE_POLL_INTERVAL_SECS", 60)?);
        let fee_topup_scan_interval =
            Duration::from_secs(parse_or("FEE_TOPUP_SCAN_INTERVAL_SECS", 300)?);
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
            stake_poll_interval,
            fee_topup_scan_interval,
            shard_size,
            swap_slippage_bps,
            keeper_fee_lamports,
            fee_topup_threshold_lamports,
            fee_topup_amount_lamports,
            lazer_access_token,
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
