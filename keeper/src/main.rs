use anyhow::Result;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use tracing::{error, info};

mod bridge_dispatcher;
mod prices;
mod events;
mod caches;
mod config;
mod executor;
mod indexer;
mod jupiter;
mod jupiter_watcher;
mod lazer_watcher;
mod price_watcher;
mod program;
mod pyth_catalog;
mod revalidate;
mod shard;
mod signer;
mod state;
mod streaming;
mod subscriber;
mod time_watcher;
mod types;
mod vaults;

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

    let rpc = std::sync::Arc::new(solana_client::nonblocking::rpc_client::RpcClient::new_with_commitment(
        cfg.rpc_url.clone(),
        solana_sdk::commitment_config::CommitmentConfig::confirmed(),
    ));
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;

    let blockhash_cache = caches::blockhash::BlockhashCache::new();
    caches::blockhash::spawn_refresher(rpc.clone(), blockhash_cache.clone());

    let priority_fee_cache = caches::priority_fee::PriorityFeeCache::new();
    let representative_accounts = vec![cfg.program_id.to_string()];
    caches::priority_fee::spawn_refresher(
        http_client.clone(),
        cfg.rpc_url.clone(),
        representative_accounts,
        priority_fee_cache.clone(),
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

    // Shared PriceCache threaded through both Lazer and Hermes SSE paths.
    let price_cache = prices::cache::PriceCache::new();

    // Feed-ids broadcaster: every 2s, derive the active hex feed-id set
    // from the WatchedSet and publish it on a watch channel so the stream
    // orchestrator knows when to restart the Hermes SSE subscription.
    let (feed_ids_tx, feed_ids_rx) = watch::channel::<Vec<String>>(vec![]);
    {
        let watched_set_for_feeds = set_rx.clone();
        let feed_ids_tx_clone = feed_ids_tx.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_secs(2));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                iv.tick().await;
                let active = watched_set_for_feeds.borrow().active_feed_ids();
                let _ = feed_ids_tx_clone.send(active);
            }
        });
    }

    // Stream orchestrator: manages the Hermes SSE subscription, restarting it
    // whenever the feed-id set changes. Lazer writes to the same cache directly.
    prices::stream::spawn(
        http_client.clone(),
        cfg.hermes_url.clone(),
        price_cache.clone(),
        feed_ids_rx,
    );

    // -----------------------------------------------------------------------
    // Events subscriber (Task 9): logsSubscribe → AutomationLifecycle →
    // WatchedSet delta-apply.
    //
    // Design note: `watch::Sender` is Clone (tokio 1.x wraps an Arc), so we
    // can give one copy to the indexer's 60s reconcile task and keep another
    // for the lifecycle apply task below. Both call `send_if_modified`, which
    // is the correct mutation API for a watch channel.
    // -----------------------------------------------------------------------
    let set_tx_for_lifecycle = set_tx.clone();

    let (lifecycle_tx, mut lifecycle_rx) = mpsc::channel::<events::AutomationLifecycle>(1024);
    let (reconcile_tx, mut reconcile_rx) = mpsc::channel::<()>(8);

    let source: std::sync::Arc<dyn streaming::StreamSource> = std::sync::Arc::new(
        streaming::ws_source::WsStreamSource::new(cfg.ws_url.clone()),
    );
    events::subscriber::spawn(
        source.clone(),
        cfg.program_id,
        lifecycle_tx,
        reconcile_tx,
    );

    // Lifecycle apply task: for each decoded event, fetch the account (if
    // needed) then mutate the WatchedSet in-place via send_if_modified so
    // all watchers see the delta without waiting for the next 60s reconcile.
    let rpc_for_lifecycle = rpc.clone();
    let lifecycle_handle = tokio::spawn(async move {
        while let Some(ev) = lifecycle_rx.recv().await {
            match indexer::resolve_lifecycle(&rpc_for_lifecycle, &ev).await {
                Ok(Some(delta)) => {
                    set_tx_for_lifecycle.send_if_modified(|ws| ws.apply_delta(delta));
                }
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(
                        target: "events::subscriber",
                        error = %e,
                        "apply_lifecycle failed; will be caught by next reconcile"
                    );
                }
            }
        }
    });

    // Reconcile-on-reconnect: every WS reconnect sentinel drains into a
    // real getProgramAccounts rescan so no automations are missed during
    // the disconnect window.
    let rpc_for_reconcile = rpc.clone();
    let set_tx_for_reconcile = set_tx.clone();
    let program_id_for_reconcile = cfg.program_id;
    let reconcile_drain_handle = tokio::spawn(async move {
        while reconcile_rx.recv().await.is_some() {
            tracing::info!(target: "main", "reconcile triggered by reconnect");
            if let Err(e) = indexer::reconcile_once(
                &rpc_for_reconcile,
                &set_tx_for_reconcile,
                &program_id_for_reconcile,
            )
            .await
            {
                tracing::warn!(target: "main", error = %e, "reconcile_once failed");
            }
        }
    });

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
        let price_cache_for_watcher = price_cache.clone();
        tokio::spawn(async move {
            if let Err(e) =
                price_watcher::run(cfg, set_rx, trigger_tx, lazer_active_feeds_rx, price_cache_for_watcher).await
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
        let price_cache_for_lazer = price_cache.clone();
        tokio::spawn(async move {
            if let Err(e) =
                lazer_watcher::run(cfg, set_rx, trigger_tx, lazer_active_feeds_tx, price_cache_for_lazer).await
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

    // TimeElapsed watcher. Coarse 60s tick, fires any rule whose
    // `created_at + duration_secs <= now`. Cheap — no network calls.
    let time_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let trigger_tx = trigger_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = time_watcher::run(cfg, set_rx, trigger_tx).await {
                error!(error = %e, "time_watcher task exited");
            }
        })
    };

    let vault_cache = vaults::VaultCache::new();
    let vault_mgr = std::sync::Arc::new(vaults::VaultManager::new(source.clone(), vault_cache.clone()));

    // Bridge dispatcher. Scans VaultCache every 2s for bridge-enabled
    // automations holding orphaned non-input-mint balances and converts
    // them back to the canonical input mint via `execute_bridge`. The
    // VaultCache is push-driven by accountSubscribe (Task 15), so the
    // 2s tick does only in-memory reads — no per-tick RPC fan-out.
    // Doesn't share the trigger_tx — it bypasses the executor and ships
    // its own tx directly, since it's not condition-driven.
    let bridge_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let vault_cache_for_bridge = vault_cache.clone();
        tokio::spawn(async move {
            if let Err(e) = bridge_dispatcher::run(cfg, set_rx, vault_cache_for_bridge).await {
                error!(error = %e, "bridge_dispatcher task exited");
            }
        })
    };

    // Vault subscription reconciler: every 2s, derive the active vault targets
    // (mint + owner PDA pairs) from the WatchedSet and reconcile
    // accountSubscribe handles. VaultManager computes each ATA address
    // deterministically — no RPC call at subscribe time.
    // Same cadence as the feed-ids loop — both are O(N) over active automations.
    let _vault_reconcile_handle = {
        let watched_set_for_vaults = set_rx.clone();
        let vault_mgr_clone = vault_mgr.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_secs(2));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                iv.tick().await;
                let desired = watched_set_for_vaults.borrow().active_vault_targets();
                vault_mgr_clone.reconcile(&desired).await;
            }
        })
    };

    let executor_handle = {
        let cfg = cfg.clone();
        let http_client = http_client.clone();
        let blockhash_cache = blockhash_cache.clone();
        let priority_fee_cache = priority_fee_cache.clone();
        tokio::spawn(async move {
            if let Err(e) = executor::run(cfg, http_client, trigger_rx, blockhash_cache, priority_fee_cache).await {
                error!(error = %e, "executor task exited");
            }
        })
    };

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("shutdown signal received");
        }
        _ = indexer_handle => error!("indexer task ended unexpectedly"),
        _ = lifecycle_handle => error!("lifecycle apply task ended unexpectedly"),
        _ = reconcile_drain_handle => error!("reconcile drain task ended unexpectedly"),
        _ = subscriber_handle => error!("subscriber task ended unexpectedly"),
        _ = price_handle => error!("price_watcher task ended unexpectedly"),
        _ = lazer_handle => error!("lazer_watcher task ended unexpectedly"),
        _ = jupiter_price_handle => error!("jupiter_watcher task ended unexpectedly"),
        _ = time_handle => error!("time_watcher task ended unexpectedly"),
        _ = bridge_handle => error!("bridge_dispatcher task ended unexpectedly"),
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
