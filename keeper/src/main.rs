use anyhow::Result;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use tracing::{error, info, warn};

mod bridge_dispatcher;
mod prices;
mod events;
mod caches;
mod config;
mod executor;
mod fills;
mod indexer;
mod jupiter;
mod jupiter_watcher;
mod lazer_watcher;
mod mints;
mod price_watcher;
mod program;
mod pyth_catalog;
mod shard;
mod signer;
mod state;
mod streaming;
mod subscriber;
mod time_watcher;
mod types;
mod vaults;

use crate::config::{KeeperConfig, StreamMode};
use crate::indexer::WatchedSet;

// Force multiple worker threads even on shared-cpu-1x. Default would
// pick `num_cpus = 1`, so any spawned task that doesn't yield often
// (e.g. busy SSE consumer, polling loop) starves the others — observed
// when the time_watcher task closure was never polled until launch.
#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
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
        stream_mode = ?cfg.stream_mode,
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

    // Address-lookup-table cache: dedupes ALT fetches across the
    // executor + bridge dispatcher so concurrent swap fires don't each
    // re-fetch Jupiter's published lookup tables.
    let lookup_table_cache = caches::lookup_table::LookupTableCache::new();

    // Treasury cache: resolves `Config.treasury` once on the first
    // swap fire, used to derive the treasury's output ATA for the
    // protocol swap fee.
    let treasury_handle = caches::treasury::TreasuryHandle::new();

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
    // In all modes this is the cache the evaluator (price_watcher) reads.
    let price_cache = prices::cache::PriceCache::new();

    // Shadow cache: populated by the SSE stream orchestrator in Off and
    // Shadow modes. The evaluator does NOT read this cache — it exists
    // solely for the Task 22 comparator to diff against live_cache.
    // In On mode the SSE orchestrator writes directly to price_cache
    // (live_cache), so shadow_cache is not needed.
    let shadow_cache: Option<prices::cache::PriceCache> = match cfg.stream_mode {
        StreamMode::Off | StreamMode::Shadow => Some(prices::cache::PriceCache::new()),
        StreamMode::On => None,
    };

    // Choose which cache the SSE stream orchestrator writes into:
    //   Off / Shadow → shadow_cache (observation only; Task 22 comparator reads it)
    //   On           → price_cache  (live; the evaluator reads this)
    let sse_target_cache = match &shadow_cache {
        Some(sc) => sc.clone(),
        None => price_cache.clone(),
    };

    info!(
        mode = ?cfg.stream_mode,
        sse_target = if shadow_cache.is_some() { "shadow_cache" } else { "live_cache" },
        "stream mode configured"
    );

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
    // whenever the feed-id set changes. In Off/Shadow modes it writes to the
    // shadow_cache (observation only). In On mode it writes to price_cache
    // (live; the evaluator reads this). Lazer always writes to price_cache
    // regardless of mode — sub-second source, no conflict with poll.
    prices::stream::spawn(
        http_client.clone(),
        cfg.hermes_url.clone(),
        sse_target_cache,
        feed_ids_rx,
    );

    // Shadow comparator (Task 22): every 5s, diff shadow_cache (SSE-fed) against
    // price_cache (Hermes-poll-fed, authoritative) and warn on divergence > 1s.
    // Only spawned in Shadow mode (shadow_cache is Some). Observation only.
    if let Some(shadow) = shadow_cache.clone() {
        let live = price_cache.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_secs(5));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                iv.tick().await;
                let s = shadow.snapshot_all().await;
                let l = live.snapshot_all().await;
                for (feed, ssnap) in &s {
                    if let Some(lsnap) = l.get(feed) {
                        let dt = (ssnap.publish_time - lsnap.publish_time).abs();
                        if dt > 1 {
                            tracing::warn!(target: "shadow", %feed, dt, "divergence > 1s");
                        }
                    }
                }
            }
        });
    }

    // -----------------------------------------------------------------------
    // Jupiter mint probe: polls Jupiter /price/v3 at 1s cadence for all
    // SPL mints needed by Jup-involved ratio triggers (Jup/Pyth, Pyth/Jup,
    // Jup/Jup) and Jupiter absolute-price triggers. Runs in all stream modes.
    // In On mode this is the sole Jupiter source for the cache-driven evaluator.
    // In Off/Shadow mode it coexists with the 12s jupiter_watcher poll.
    // -----------------------------------------------------------------------
    let mint_cache = mints::cache::MintPriceCache::new();

    // Load the Pyth catalog for the mint probe's active-mints derivation.
    // Best-effort: failure here means non-Pyth quote mints may also be
    // probed (harmless — the probe just fetches more mints than needed).
    // The handle is shared with a background refresher that swaps in a
    // fresh catalog every 5 minutes so newly-listed Pyth feeds become
    // recognizable without a keeper restart.
    let initial_catalog = match crate::pyth_catalog::fetch().await {
        Ok(c) => {
            info!(feeds = c.len(), "main: loaded Pyth catalog for mint probe");
            c
        }
        Err(e) => {
            tracing::warn!(error = %e, "main: Pyth catalog load failed for mint probe; catalog treated as empty");
            crate::pyth_catalog::PythCatalog::new()
        }
    };
    let pyth_catalog_handle = crate::pyth_catalog::PythCatalogHandle::new(initial_catalog);
    crate::pyth_catalog::spawn_refresher(pyth_catalog_handle.clone());

    // Watch channel that carries the current active Jupiter mint set to the probe.
    let (mints_tx, mints_rx) = tokio::sync::watch::channel::<Vec<solana_sdk::pubkey::Pubkey>>(vec![]);

    // Spawn the probe (1s base, exponential backoff on errors).
    mints::probe::spawn(
        http_client.clone(),
        cfg.jupiter_price_url.clone(),
        cfg.jupiter_api_key.clone(),
        mints_rx,
        mint_cache.clone(),
    );

    // Republish active mints every 2s so the probe tracks new automations.
    // Takes a snapshot of the catalog each tick so it sees fresh feeds as
    // the background refresher swaps them in.
    {
        let watched_set_for_mints = set_rx.clone();
        let catalog_for_mints = pyth_catalog_handle.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(std::time::Duration::from_secs(2));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                iv.tick().await;
                let catalog_snap = catalog_for_mints.snapshot().await;
                let mints = watched_set_for_mints
                    .borrow()
                    .active_jupiter_mints(&catalog_snap);
                let _ = mints_tx.send(mints);
            }
        });
    }

    // FillCache: populated by the lifecycle apply task on each AutomationFilled
    // event. Read by price_watcher's PriceRelativeToFill evaluator branch.
    // When KEEPER_FILL_CACHE_PATH is set, fills survive keeper restarts.
    let fill_cache = match &cfg.fill_cache_path {
        Some(p) => fills::cache::FillCache::with_persistence(p.clone())
            .unwrap_or_else(|e| {
                tracing::warn!(
                    target: "main",
                    error = %e,
                    path = %p.display(),
                    "fill cache persistence init failed; falling back to in-memory"
                );
                fills::cache::FillCache::new()
            }),
        None => fills::cache::FillCache::new(),
    };

    // -----------------------------------------------------------------------
    // Events subscriber (Task 9): logsSubscribe → AutomationLifecycle →
    // WatchedSet delta-apply.
    //
    // Design note: `watch::Sender` is Clone (tokio 1.x wraps an Arc), so we
    // can give one copy to the indexer's reconcile task and keep another
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
    // all watchers see the delta without waiting for the next 5min reconcile.
    //
    // AutomationFilled events are handled here too: the FillCache is updated
    // with the effective USD per output unit (computed via compute_effective_fill).
    // Filled events do NOT mutate the WatchedSet — the automation still exists.
    let rpc_for_lifecycle = rpc.clone();
    let fill_cache_for_lifecycle = fill_cache.clone();
    let price_cache_for_lifecycle = price_cache.clone();
    let mint_cache_for_lifecycle = mint_cache.clone();
    let lifecycle_handle = tokio::spawn(async move {
        while let Some(ev) = lifecycle_rx.recv().await {
            // Handle Filled events separately: update FillCache, skip WatchedSet.
            if let events::AutomationLifecycle::Filled(ref f) = ev {
                match compute_effective_fill(
                    &rpc_for_lifecycle,
                    &price_cache_for_lifecycle,
                    &mint_cache_for_lifecycle,
                    f,
                )
                .await
                {
                    Ok(fill) => {
                        info!(
                            target: "fills",
                            upstream = %fill.upstream,
                            input_amount = f.input_amount,
                            output_amount = f.output_amount,
                            effective_usd = fill.effective_usd_per_output,
                            "fill recorded"
                        );
                        fill_cache_for_lifecycle.put(fill).await;
                    }
                    Err(reason) => {
                        warn!(
                            target: "fills",
                            upstream = %f.automation,
                            input_amount = f.input_amount,
                            output_amount = f.output_amount,
                            fill_slot = f.fill_slot,
                            %reason,
                            runbook = "docs/superpowers/runbooks/fills.md",
                            "fill rejected; downstream PriceRelativeToFill triggers on this upstream cannot fire"
                        );
                    }
                }
                continue;
            }

            // Created / Updated / Finished: update WatchedSet.
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

    // In On mode the 12s Hermes poll is suppressed — the SSE consumer
    // is writing to live_cache directly, so the poll would be redundant.
    // In Off and Shadow modes the poll is the authoritative price source.
    let suppress_hermes_poll = cfg.stream_mode == StreamMode::On;

    let price_handle = {
        let cfg = cfg.clone();
        let set_rx = set_rx.clone();
        let trigger_tx = trigger_tx.clone();
        let lazer_active_feeds_rx = lazer_active_feeds_rx.clone();
        let price_cache_for_watcher = price_cache.clone();
        let mint_cache_for_watcher = mint_cache.clone();
        let fill_cache_for_watcher = fill_cache.clone();
        let pyth_catalog_for_watcher = pyth_catalog_handle.clone();
        tokio::spawn(async move {
            if let Err(e) =
                price_watcher::run(cfg, set_rx, trigger_tx, lazer_active_feeds_rx, price_cache_for_watcher, suppress_hermes_poll, mint_cache_for_watcher, fill_cache_for_watcher, pyth_catalog_for_watcher).await
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
        let pyth_catalog_for_jupiter = pyth_catalog_handle.clone();
        tokio::spawn(async move {
            if let Err(e) = jupiter_watcher::run(cfg, set_rx, trigger_tx, pyth_catalog_for_jupiter).await {
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
        let blockhash_cache_for_bridge = blockhash_cache.clone();
        let priority_fee_cache_for_bridge = priority_fee_cache.clone();
        let lookup_table_cache_for_bridge = lookup_table_cache.clone();
        tokio::spawn(async move {
            if let Err(e) = bridge_dispatcher::run(
                cfg,
                set_rx,
                vault_cache_for_bridge,
                blockhash_cache_for_bridge,
                priority_fee_cache_for_bridge,
                lookup_table_cache_for_bridge,
            )
            .await
            {
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
        let lookup_table_cache = lookup_table_cache.clone();
        let treasury_handle = treasury_handle.clone();
        tokio::spawn(async move {
            if let Err(e) = executor::run(
                cfg,
                http_client,
                trigger_rx,
                blockhash_cache,
                priority_fee_cache,
                lookup_table_cache,
                treasury_handle,
            )
            .await
            {
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

// ---------------------------------------------------------------------------
// Fill price computation helper
// ---------------------------------------------------------------------------

/// Structured rejection reason for `compute_effective_fill`.
///
/// Every early-return path produces a typed variant so the call site can
/// emit a structured `warn!` with a `reason` field — no silent `None`.
#[derive(Debug, Clone, thiserror::Error)]
pub enum FillRejection {
    #[error("upstream automation could not be fetched: {0}")]
    AutomationFetch(String),
    #[error("upstream automation could not be decoded")]
    AutomationDecode,
    #[error("input mint USD price unavailable (mint: {mint})")]
    InputPriceMissing { mint: String },
    #[error("zero output_amount — would divide by zero")]
    ZeroOutput,
    #[error("missing input/output decimals (mint: {mint})")]
    DecimalsMissing { mint: String },
}

/// USDC mainnet mint. Stable: 1 USDC ≈ $1.00.
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// USDT mainnet mint. Stable: 1 USDT ≈ $1.00.
const USDT_MINT: &str = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/// Pure computation: effective USD per output unit.
///
/// Returns `Err(FillRejection::ZeroOutput)` if `output_amount == 0`.
/// Otherwise: `(input_amount / 10^input_decimals * input_usd_price) / (output_amount / 10^output_decimals)`.
pub(crate) fn compute_effective_usd_per_output(
    input_amount: u64,
    output_amount: u64,
    input_decimals: u8,
    output_decimals: u8,
    input_usd_price: f64,
) -> Result<f64, FillRejection> {
    if output_amount == 0 {
        return Err(FillRejection::ZeroOutput);
    }
    let input_real = (input_amount as f64) / 10f64.powi(input_decimals as i32);
    let output_real = (output_amount as f64) / 10f64.powi(output_decimals as i32);
    let input_usd = input_real * input_usd_price;
    Ok(input_usd / output_real)
}

/// Compute the effective USD price per output unit from an `AutomationFilled`
/// event. Returns `Err(FillRejection)` with a typed reason whenever the fill
/// cannot be priced; the call site logs the rejection with structured fields.
///
/// Algorithm:
///   1. Fetch and decode the upstream automation account to get input_mint,
///      output_mint, and their decimals (from the Swap action).
///   2. Look up the input mint's USD price (stable → 1.0, Pyth → PriceCache,
///      else → MintPriceCache).
///   3. Delegate the pure division to `compute_effective_usd_per_output`.
async fn compute_effective_fill(
    rpc: &std::sync::Arc<solana_client::nonblocking::rpc_client::RpcClient>,
    price_cache: &crate::prices::cache::PriceCache,
    mint_price_cache: &crate::mints::cache::MintPriceCache,
    ev: &crate::state::AutomationFilledEvent,
) -> Result<crate::fills::cache::Fill, FillRejection> {
    use std::str::FromStr;

    // Step 1: Fetch and decode the upstream automation account.
    let account = rpc
        .get_account(&ev.automation)
        .await
        .map_err(|e| FillRejection::AutomationFetch(e.to_string()))?;

    let automation = crate::state::Automation::from_account_data(&account.data)
        .map_err(|_| FillRejection::AutomationDecode)?;

    // Step 2: Extract input_mint and output_mint from the Swap action.
    let (input_mint, output_mint) = match &automation.action {
        crate::state::ActionSpec::Swap { input_mint, output_mint, .. } => {
            (*input_mint, *output_mint)
        }
        _ => {
            return Err(FillRejection::AutomationDecode);
        }
    };

    // Step 3: Fetch decimals for input and output mints via getAccountInfo.
    let input_decimals = fetch_mint_decimals(rpc, &input_mint).await.unwrap_or(6);
    let output_decimals = fetch_mint_decimals(rpc, &output_mint).await.unwrap_or(6);

    // Step 4: Resolve input mint USD price.
    let usdc = solana_sdk::pubkey::Pubkey::from_str(USDC_MINT).expect("USDC constant valid");
    let usdt = solana_sdk::pubkey::Pubkey::from_str(USDT_MINT).expect("USDT constant valid");

    let input_usd_price = if input_mint == usdc || input_mint == usdt {
        1.0_f64
    } else {
        // Try MintPriceCache (Jupiter probe) first — it covers all SPL mints.
        if let Some(snap) = mint_price_cache.get_fresh(&input_mint).await {
            snap.price_usd
        } else {
            // Fall back to PriceCache (Pyth) using the mint bytes as feed hex.
            let feed_hex = crate::price_watcher::pubkey_to_hex(&input_mint);
            if let Some(snap) = price_cache.get_fresh(&feed_hex).await {
                snap.price
            } else {
                return Err(FillRejection::InputPriceMissing {
                    mint: input_mint.to_string(),
                });
            }
        }
    };

    // Step 5: Compute effective USD per output unit.
    let effective_usd_per_output = compute_effective_usd_per_output(
        ev.input_amount,
        ev.output_amount,
        input_decimals,
        output_decimals,
        input_usd_price,
    )?;

    tracing::debug!(
        target: "fills",
        automation = %ev.automation,
        input_amount = ev.input_amount,
        output_amount = ev.output_amount,
        input_decimals,
        output_decimals,
        input_usd_price,
        effective_usd_per_output,
        fill_slot = ev.fill_slot,
        "computed effective fill price"
    );

    Ok(crate::fills::cache::Fill {
        upstream: ev.automation,
        effective_usd_per_output,
        fill_slot: ev.fill_slot,
        observed_at: std::time::Instant::now(),
    })
}

/// Fetch the decimal count for an SPL mint via `getAccountInfo`.
/// SPL mint layout: 44 bytes header, byte 44 = decimals.
/// Returns `None` on any error so callers can fall back to a safe default.
async fn fetch_mint_decimals(
    rpc: &std::sync::Arc<solana_client::nonblocking::rpc_client::RpcClient>,
    mint: &solana_sdk::pubkey::Pubkey,
) -> Option<u8> {
    let account = rpc.get_account(mint).await.ok()?;
    // SPL Mint layout (v1/v2):
    //   [0..4]  mint_authority option tag (4 bytes)
    //   [4..36] mint_authority pubkey (32 bytes)
    //   [36..44] supply (u64, 8 bytes)
    //   [44]   decimals (u8)
    if account.data.len() >= 45 {
        Some(account.data[44])
    } else {
        None
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_btc_at_80k_to_one_wbtc_gives_80k_per_wbtc() {
        // 1 BTC (9 dec) at $80,000 → 1 WBTC (8 dec)
        let r = compute_effective_usd_per_output(
            1_000_000_000, // 1.0 BTC
            100_000_000,   // 1.0 WBTC
            9,
            8,
            80_000.0,
        )
        .unwrap();
        assert!((r - 80_000.0).abs() < 1e-6, "got {r}");
    }

    #[test]
    fn usdc_six_decimals_to_sol_nine_decimals() {
        // 100 USDC (6 dec) at $1 → 0.5 SOL (9 dec) → $200/SOL
        let r = compute_effective_usd_per_output(
            100_000_000, // 100 USDC
            500_000_000, // 0.5 SOL
            6,
            9,
            1.0,
        )
        .unwrap();
        assert!((r - 200.0).abs() < 1e-9);
    }

    #[test]
    fn zero_output_returns_zero_output_rejection() {
        let r = compute_effective_usd_per_output(1_000, 0, 6, 9, 1.0);
        assert!(matches!(r, Err(FillRejection::ZeroOutput)));
    }

    #[test]
    fn slippage_eats_into_price_correctly() {
        // 1 BTC paid (9 dec) at $80k → 0.99 WBTC received (8 dec, slippage)
        // Effective USD per WBTC = 80_000 / 0.99 = ~$80,808.08
        let r = compute_effective_usd_per_output(
            1_000_000_000,
            99_000_000, // 0.99 WBTC
            9,
            8,
            80_000.0,
        )
        .unwrap();
        assert!((r - 80_808.0808).abs() < 0.001, "got {r}");
    }

    #[test]
    fn small_amounts_dont_lose_precision_excessively() {
        // 0.000001 BTC (1000 base units, 9 dec) at $80k → 0.0000005 WBTC (50 base, 8 dec)
        // Effective USD per WBTC = (1e-6 * 80000) / 5e-7 = 0.08 / 5e-7 = 160_000
        let r = compute_effective_usd_per_output(1_000, 50, 9, 8, 80_000.0).unwrap();
        assert!((r - 160_000.0).abs() < 1e-3, "got {r}");
    }
}
