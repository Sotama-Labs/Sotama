use anyhow::Result;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use tracing::{error, info};

mod config;
mod executor;
mod indexer;
mod jupiter;
mod jupiter_watcher;
mod lazer_watcher;
mod price_watcher;
mod program;
mod revalidate;
mod shard;
mod signer;
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

    // Shared state: which feed pubkeys is Lazer currently streaming?
    // price_watcher (Hermes) reads this and skips them so the two paths
    // don't both fire on the same crossing. Empty when Lazer is down,
    // so Hermes covers everything during Lazer outages.
    let (lazer_active_feeds_tx, lazer_active_feeds_rx) =
        watch::channel::<HashSet<solana_sdk::pubkey::Pubkey>>(HashSet::new());

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
        let lazer_active_feeds_rx = lazer_active_feeds_rx.clone();
        tokio::spawn(async move {
            if let Err(e) =
                price_watcher::run(cfg, set_rx, trigger_tx, lazer_active_feeds_rx).await
            {
                error!(error = %e, "price_watcher task exited");
            }
        })
    };

    // Optional Pyth Lazer watcher. Runs alongside price_watcher when
    // LAZER_ACCESS_TOKEN is set: Lazer fires sub-second, Hermes polls at
    // 12s as backup, executor's dedupe drops the slower duplicate. Returns
    // immediately as a no-op if the token is unset, so this spawn is
    // always safe.
    let lazer_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let trigger_tx = trigger_tx.clone();
        let lazer_active_feeds_tx = lazer_active_feeds_tx.clone();
        tokio::spawn(async move {
            if let Err(e) =
                lazer_watcher::run(cfg, set_rx, trigger_tx, lazer_active_feeds_tx).await
            {
                error!(error = %e, "lazer_watcher task exited");
            }
        })
    };

    // Jupiter Price v3 watcher. Handles AssetPrice triggers whose
    // `source = oracle_source::JUPITER` (tokens without a Pyth feed).
    // Returns immediately as a no-op when JUPITER_PRICE_ENABLED=0.
    let jupiter_price_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let trigger_tx = trigger_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = jupiter_watcher::run(cfg, set_rx, trigger_tx).await {
                error!(error = %e, "jupiter_watcher task exited");
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
        _ = lazer_handle => error!("lazer_watcher task ended unexpectedly"),
        _ = jupiter_price_handle => error!("jupiter_watcher task ended unexpectedly"),
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
