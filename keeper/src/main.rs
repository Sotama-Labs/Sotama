use anyhow::Result;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use tracing::{error, info};

mod config;
mod executor;
mod indexer;
mod jupiter;
mod price_watcher;
mod program;
mod revalidate;
mod shard;
mod signer;
mod stake_watcher;
mod state;
mod subscriber;
mod types;

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let cfg = Arc::new(KeeperConfig::from_env()?);
    info!(
        cluster = cfg.cluster.label(),
        program_id = %cfg.program_id,
        keeper = %cfg.keeper_pubkey,
        rpc = %cfg.rpc_url,
        ws = %cfg.ws_url,
        sender = %cfg.sender_url,
        jupiter = %cfg.jupiter_base_url,
        "sotama-keeper starting"
    );

    let initial = indexer::seed_initial(&cfg).await?;
    info!(
        active = initial.len(),
        "indexer: seeded initial active automations"
    );
    let (set_tx, set_rx) = watch::channel(WatchedSet::from_index(initial));

    let (trigger_tx, trigger_rx) = mpsc::channel::<types::TriggerEvent>(1024);

    let indexer_handle = {
        let cfg = cfg.clone();
        tokio::spawn(async move {
            if let Err(e) = indexer::run(cfg, set_tx).await {
                error!(error = %e, "indexer task exited");
            }
        })
    };

    let subscriber_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let trigger_tx = trigger_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = subscriber::run(cfg, set_rx, trigger_tx).await {
                error!(error = %e, "subscriber task exited");
            }
        })
    };

    let price_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let trigger_tx = trigger_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = price_watcher::run(cfg, set_rx, trigger_tx).await {
                error!(error = %e, "price_watcher task exited");
            }
        })
    };

    let stake_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let trigger_tx = trigger_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = stake_watcher::run(cfg, set_rx, trigger_tx).await {
                error!(error = %e, "stake_watcher task exited");
            }
        })
    };

    let executor_handle = {
        let cfg = cfg.clone();
        tokio::spawn(async move {
            if let Err(e) = executor::run(cfg, trigger_rx).await {
                error!(error = %e, "executor task exited");
            }
        })
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("shutdown signal received");
        }
        _ = indexer_handle => error!("indexer task ended unexpectedly"),
        _ = subscriber_handle => error!("subscriber task ended unexpectedly"),
        _ = price_handle => error!("price_watcher task ended unexpectedly"),
        _ = stake_handle => error!("stake_watcher task ended unexpectedly"),
        _ = executor_handle => error!("executor task ended unexpectedly"),
    }

    Ok(())
}

fn init_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,sotama_keeper=debug"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_level(true))
        .init();
}
