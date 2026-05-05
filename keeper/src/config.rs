use anyhow::{anyhow, Context, Result};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{read_keypair_file, Keypair, Signer};
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

pub struct KeeperConfig {
    pub api_key: String,
    pub rpc_url: String,
    pub ws_url: String,
    pub sender_url: String,
    pub keeper_keypair: Keypair,
    pub keeper_pubkey: Pubkey,
    pub program_id: Pubkey,
    pub reconcile_interval: Duration,
    pub shard_size: usize,
}

impl KeeperConfig {
    pub fn from_env() -> Result<Self> {
        let api_key = required("HELIUS_API_KEY")?;
        let rpc_base = required_or("HELIUS_DEVNET_RPC", "https://devnet.helius-rpc.com")?;
        let ws_base = required_or("HELIUS_DEVNET_WS", "wss://atlas-devnet.helius-rpc.com")?;
        let sender_url =
            required_or("HELIUS_DEVNET_SENDER", "https://devnet-sender.helius-rpc.com/fast")?;

        let rpc_url = format!("{}/?api-key={}", rpc_base.trim_end_matches('/'), api_key);
        let ws_url = format!("{}/?api-key={}", ws_base.trim_end_matches('/'), api_key);

        let keypair_path: PathBuf = required("KEEPER_KEYPAIR_PATH")?.into();
        let keeper_keypair = read_keypair_file(&keypair_path)
            .map_err(|e| anyhow!("failed to read keeper keypair {keypair_path:?}: {e}"))?;
        let keeper_pubkey = keeper_keypair.pubkey();

        let program_id_str = required("PROGRAM_ID")?;
        let program_id = Pubkey::from_str(&program_id_str)
            .with_context(|| format!("invalid PROGRAM_ID `{program_id_str}`"))?;

        let reconcile_interval = Duration::from_secs(parse_or("RECONCILE_INTERVAL_SECS", 60)?);
        let shard_size = parse_or::<usize>("SHARD_SIZE", 40)?.max(1);

        Ok(Self {
            api_key,
            rpc_url,
            ws_url,
            sender_url,
            keeper_keypair,
            keeper_pubkey,
            program_id,
            reconcile_interval,
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
