use anyhow::{anyhow, Context, Result};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use crate::signer::{load_signer, KeeperSigner};

pub struct KeeperConfig {
    pub api_key: String,
    pub rpc_url: String,
    pub ws_url: String,
    pub sender_url: String,
    pub hermes_url: String,
    pub signer: Arc<dyn KeeperSigner>,
    pub keeper_pubkey: Pubkey,
    pub program_id: Pubkey,
    pub reconcile_interval: Duration,
    pub price_poll_interval: Duration,
    pub stake_poll_interval: Duration,
    pub shard_size: usize,
}

impl KeeperConfig {
    pub fn from_env() -> Result<Self> {
        let api_key = required("HELIUS_API_KEY")?;
        let rpc_base = required_or("HELIUS_DEVNET_RPC", "https://devnet.helius-rpc.com")?;
        let ws_base = required_or("HELIUS_DEVNET_WS", "wss://atlas-devnet.helius-rpc.com")?;
        let sender_url = required_or(
            "HELIUS_DEVNET_SENDER",
            "https://devnet.helius-rpc.com/?api-key=__APIKEY__",
        )?;
        let hermes_url = required_or("PYTH_HERMES_URL", "https://hermes.pyth.network")?;

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
        let shard_size = parse_or::<usize>("SHARD_SIZE", 40)?.max(1);

        Ok(Self {
            api_key,
            rpc_url,
            ws_url,
            sender_url,
            hermes_url,
            signer,
            keeper_pubkey,
            program_id,
            reconcile_interval,
            price_poll_interval,
            stake_poll_interval,
            shard_size,
        })
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
