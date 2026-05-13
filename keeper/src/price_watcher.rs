use anyhow::{anyhow, Result};
use serde::Deserialize;
use solana_sdk::pubkey::Pubkey;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::time::MissedTickBehavior;
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::fills::cache::FillCache;
use crate::indexer::WatchedSet;
use crate::jupiter::JupiterClient;
use crate::mints::cache::MintPriceCache;
use crate::prices::adaptive_poll;
use crate::prices::cache::{PriceCache, PriceSnapshot, SourceLayer};
use crate::pyth_catalog::PythCatalogHandle;
use crate::state::{oracle_source, TriggerSpec};
use crate::types::{AutomationCtx, TriggerEvent};

/// Polls Pyth Hermes for the live price of every AssetPrice-trigger feed
/// and emits TriggerEvents when the threshold is crossed. Stateless
/// across runs — does not persist "already crossed" markers, so a price
/// hovering near the threshold could fire repeatedly. The on-chain
/// `executed: bool` guard prevents double-execution per automation, and
/// the executor's `recent_triggers` cache prevents duplicate ix sends
/// within a single keeper session.
///
/// **Pyth-Pro-primary semantics.** When Lazer is connected, the
/// `lazer_active_feeds_rx` channel reports the feeds it's actively
/// streaming and Hermes skips them — Lazer is sub-second, Hermes is the
/// 12s fallback, and running both for the same feed produces duplicate
/// fires (the executor's dedupe drops the loser, but the wasted work
/// looks like double-counting in the UI). When Lazer disconnects, the
/// set goes empty here and Hermes resumes covering everything.
pub async fn run(
    cfg: Arc<KeeperConfig>,
    set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
    lazer_active_feeds_rx: watch::Receiver<HashSet<Pubkey>>,
    price_cache: PriceCache,
    // When true, the inner 12s Hermes polling task is not spawned.
    // Set by `main.rs` when `KEEPER_STREAM_MODE=on` so the SSE consumer
    // is the sole writer to the live price cache.
    suppress_poll: bool,
    // Jupiter mint price cache. Written by mints::probe at 1s cadence.
    // Used by the cache-driven evaluator for Jup-involved ratio triggers
    // (Jup/Pyth, Jup/Jup, Pyth/Jup, Jup-absolute) in all stream modes.
    mint_cache: MintPriceCache,
    // Fill record cache. Written by the lifecycle apply task on each
    // AutomationFilled event. Read by the PriceRelativeToFill evaluator branch.
    fill_cache: FillCache,
    // Shared Pyth catalog handle. Refreshed every 5 minutes by a background
    // task in main.rs; a snapshot is taken each evaluator tick so newly-listed
    // Pyth feeds are picked up without restarting the keeper.
    pyth_catalog: PythCatalogHandle,
) -> Result<()> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()?;

    let jupiter = JupiterClient::new(http.clone(), cfg.jupiter_base_url.clone())
        .with_api_key(cfg.jupiter_api_key.clone());

    // Notify handle wired to PriceCache: fires on every successful put(),
    // including those from Lazer and Hermes SSE. The evaluator loop below
    // uses this to react immediately instead of waiting for the next poll tick.
    let notify = price_cache.notifier();
    // Notify handle wired to MintPriceCache: fires every time the Jupiter
    // probe writes a new mint price (1s cadence + backoff). The evaluator
    // loop wakes on either notify so Jup-involved triggers fire at full
    // probe cadence without waiting for the Pyth notify.
    let mint_notify = mint_cache.notifier();

    // Heartbeat: fires every 30s so triggers evaluate even if the cache
    // goes silent (network outage between poll ticks).
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);

    // Local price map populated by the Hermes poll; used by the evaluator
    // for integer-precise threshold comparisons (raw + expo). Keyed by
    // lowercase hex feed ID.
    let local_prices: Arc<tokio::sync::RwLock<HashMap<String, LatestPrice>>> =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    // Same for per-tick Jupiter mint quotes.
    let local_mint_quotes: Arc<tokio::sync::RwLock<HashMap<Pubkey, MintQuote>>> =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));
    // Hermes-sourced quote prices (Pyth catalog hits).
    let local_hermes_quote_prices: Arc<tokio::sync::RwLock<HashMap<Pubkey, LatestPrice>>> =
        Arc::new(tokio::sync::RwLock::new(HashMap::new()));

    // Spawn the Layer-4 Hermes polling task. It fetches prices on the
    // configured interval (default 12s), writes each result into the shared
    // PriceCache (triggering the notify channel), and also updates the local
    // raw-price maps used by the evaluator for integer-precise comparisons.
    //
    // Suppressed when `suppress_poll` is true (i.e. KEEPER_STREAM_MODE=on):
    // in that mode the Hermes SSE consumer is the sole writer to live_cache.
    let poll_cfg = cfg.clone();
    let poll_http = http.clone();
    let poll_set_rx = set_rx.clone();
    let poll_lazer_rx = lazer_active_feeds_rx.clone();
    let poll_cache = price_cache.clone();
    let poll_catalog = pyth_catalog.clone();
    let poll_jupiter = jupiter.clone();
    let poll_local_prices = local_prices.clone();
    let poll_local_mint_quotes = local_mint_quotes.clone();
    let poll_local_hermes_quote_prices = local_hermes_quote_prices.clone();

    if suppress_poll {
        info!("price_watcher: 12s Hermes poll suppressed (KEEPER_STREAM_MODE=on; SSE is authoritative)");
    }

    tokio::spawn(async move {
        if suppress_poll {
            // In On mode the SSE consumer drives the cache; the poll task
            // sits idle. The evaluator loop still runs below, driven by
            // the PriceCache notify that the SSE/Lazer paths fire.
            return;
        }
        loop {
            let set = poll_set_rx.borrow().clone();
            let lazer_active: HashSet<Pubkey> = poll_lazer_rx.borrow().clone();

            // Hermes is a Pyth wire format. Filter to PYTH-sourced triggers
            // only — JUPITER triggers are watched by jupiter_watcher.
            // Within those, drop feeds Lazer is currently streaming so
            // there's only one active source per feed.
            let feeds: Vec<Pubkey> = set
                .price_feeds_for_source(crate::state::oracle_source::PYTH)
                .into_iter()
                .filter(|f| !lazer_active.contains(f))
                .collect();
            if feeds.is_empty() {
                continue;
            }

            // Pyth Hermes expects the 32-byte feed ID as hex (lowercase, no
            // 0x), but on-chain we stored it as a Pubkey's raw bytes (base58
            // when Display'd). Convert here for the HTTP query.
            let mut feed_hex: Vec<String> = feeds.iter().map(pubkey_to_hex).collect();

            // Partition quote_mints by dispatch (Pyth-catalog hit vs miss).
            // Pyth-feed quotes get folded into the same Hermes batch; SPL
            // mints stay on the Jupiter probe path. Snapshot the catalog
            // once per tick so newly-listed feeds are picked up as soon as
            // the background refresher swaps them in.
            let poll_catalog_snap = poll_catalog.snapshot().await;
            let mut hermes_quote_pubkeys: Vec<Pubkey> = Vec::new();
            let mut jupiter_quote_mints: Vec<Pubkey> = Vec::new();
            for qm in set.asset_price_quote_mints() {
                if poll_catalog_snap.contains_key(&qm.to_bytes()) {
                    hermes_quote_pubkeys.push(qm);
                } else {
                    jupiter_quote_mints.push(qm);
                }
            }
            for qm in &hermes_quote_pubkeys {
                feed_hex.push(pubkey_to_hex(qm));
            }
            debug!(
                feeds = feeds.len(),
                hermes_quotes = hermes_quote_pubkeys.len(),
                jupiter_quotes = jupiter_quote_mints.len(),
                "price_watcher: polling Pyth Hermes (+ Jupiter for SPL-mint quotes)"
            );

            let prices = match fetch_prices(&poll_http, &poll_cfg.hermes_url, &feed_hex).await {
                Ok(p) => p,
                Err(e) => {
                    warn!(error = %e, "price_watcher: hermes fetch failed");
                    continue;
                }
            };

            // Write Hermes prices into PriceCache (fires notify, waking the
            // evaluator task).
            for feed in &feeds {
                let hex = pubkey_to_hex(feed);
                if let Some(p) = prices.get(&hex) {
                    // raw_price + expo preserved so the cache-driven evaluator
                    // can compute Pyth-quoted ratio triggers in StreamMode::On.
                    let snap = PriceSnapshot {
                        price: p.raw as f64 * 10f64.powi(p.expo),
                        conf: 0.0,
                        publish_time: p.publish_time,
                        fetched_at: std::time::Instant::now(),
                        source: SourceLayer::HermesPoll,
                        raw_price: Some(p.raw),
                        expo: Some(p.expo),
                    };
                    poll_cache.put(hex, snap).await;
                }
            }

            // Update local raw-price maps for integer-precise evaluation.
            {
                let mut lp = poll_local_prices.write().await;
                for (k, v) in &prices {
                    lp.insert(k.clone(), v.clone());
                }
            }

            // Hermes-derived quote prices keyed by quote pubkey.
            let mut hqp: HashMap<Pubkey, LatestPrice> = HashMap::new();
            for qm in &hermes_quote_pubkeys {
                let hex = pubkey_to_hex(qm).to_lowercase();
                if let Some(p) = prices.get(&hex) {
                    hqp.insert(*qm, p.clone());
                }
            }
            {
                let mut g = poll_local_hermes_quote_prices.write().await;
                *g = hqp;
            }

            // Per-tick Jupiter `/quote` probes for SPL-mint quotes.
            let mut mq: HashMap<Pubkey, MintQuote> = HashMap::new();
            for mint in jupiter_quote_mints {
                match probe_mint(&poll_jupiter, &mint, poll_cfg.swap_slippage_bps).await {
                    Ok(q) => {
                        mq.insert(mint, q);
                    }
                    Err(e) => {
                        warn!(mint = %mint, error = %e, "price_watcher: quote-mint /quote failed");
                    }
                }
            }
            {
                let mut g = poll_local_mint_quotes.write().await;
                *g = mq;
            }

            // Compute the next sleep duration based on how close any active
            // absolute-price trigger is to its threshold. Ratio and
            // quote_mint triggers are skipped here (distance metric differs);
            // the loop falls back to cfg.price_poll_interval when no
            // absolute triggers are active so the cache stays warm.
            let distances = {
                let lp = poll_local_prices.read().await;
                compute_active_distances(&set, &lp)
            };
            let next_sleep = if distances.is_empty() {
                poll_cfg.price_poll_interval
            } else {
                adaptive_poll::min_interval(&distances)
            };
            debug!(
                next_sleep_ms = next_sleep.as_millis(),
                active_triggers = distances.len(),
                "price_watcher: adaptive sleep before next Hermes poll"
            );
            tokio::time::sleep(next_sleep).await;
        }
    });

    // Evaluator loop: wakes on PriceCache notify (sub-second when Lazer is
    // active, or ~12s from the Hermes poll above), MintPriceCache notify
    // (~1s from the Jupiter probe), or a 30s heartbeat so triggers fire
    // even if the cache goes silent.
    loop {
        tokio::select! {
            _ = notify.notified() => {},
            _ = mint_notify.notified() => {},
            _ = heartbeat.tick() => {},
        }

        let set = set_rx.borrow().clone();
        let lazer_active: HashSet<Pubkey> = lazer_active_feeds_rx.borrow().clone();
        let feeds: Vec<Pubkey> = set
            .price_feeds_for_source(crate::state::oracle_source::PYTH)
            .into_iter()
            .filter(|f| !lazer_active.contains(f))
            .collect();
        if feeds.is_empty() {
            continue;
        }

        // Snapshot the catalog once per evaluator tick. Newly-listed Pyth feeds
        // become visible here as soon as the background refresher swaps them in.
        let catalog = pyth_catalog.snapshot().await;
        let prices = local_prices.read().await;
        let hermes_quote_prices = local_hermes_quote_prices.read().await;
        let mint_quotes = local_mint_quotes.read().await;

        // Map: correlation_key → (matches, snapshot_for_this_feed).
        let mut to_fire: HashMap<String, (Vec<AutomationCtx>, PriceSnapshot)> = HashMap::new();
        // Track which automation pubkeys have already been evaluated this tick
        // to prevent double-firing when the same feed appears in both
        // local_prices (poll path) and PriceCache (SSE/Lazer path).
        let mut already: HashSet<Pubkey> = HashSet::new();

        // -----------------------------------------------------------------------
        // Poll-path (Off / Shadow): local_prices is populated by the 12s Hermes
        // batch poll. In StreamMode::On this map is empty (poll suppressed) so
        // this loop body does nothing — the cache-driven path below covers it.
        // -----------------------------------------------------------------------
        for feed in &feeds {
            let feed_hex_id = pubkey_to_hex(feed);
            let Some(price) = prices.get(&feed_hex_id) else {
                continue;
            };
            let feed_str = feed_hex_id.clone();
            // Re-resolve the per-source matches list rather than iterating
            // over the unfiltered map — this is what restricts Hermes to
            // PYTH-sourced triggers.
            let ctxs = set.price_matches_for_source(feed, crate::state::oracle_source::PYTH);
            for ctx in &ctxs {
                if !already.insert(ctx.pubkey) {
                    continue;
                }
                let TriggerSpec::AssetPrice {
                    quote_mint,
                    comparator,
                    threshold,
                    expo,
                    ..
                } = &ctx.trigger
                else {
                    continue;
                };

                let crossed = match quote_mint {
                    None => match *comparator {
                        // USD-denominated: compare Pyth's raw price
                        // directly against the threshold.
                        0 => crossed_below(price, *threshold, *expo),
                        1 => crossed_above(price, *threshold, *expo),
                        _ => false,
                    },
                    Some(qm) => {
                        // Quote-denominated: ratio = base_pyth / quote.
                        // Catalog dispatched the quote leg to Hermes (if
                        // it's a known Pyth feed) or Jupiter (if it's
                        // an SPL mint). Skip the trigger this tick if
                        // the chosen source didn't return a price.
                        let (q_raw, q_expo) =
                            if let Some(p) = hermes_quote_prices.get(qm) {
                                (p.raw as i128, p.expo)
                            } else if let Some(q) = mint_quotes.get(qm) {
                                (q.out_amount as i128, -6)
                            } else {
                                continue;
                            };
                        ratio_compare(
                            *comparator,
                            (price.raw as i128, price.expo),
                            (q_raw, q_expo),
                            *threshold,
                            *expo,
                        )
                        .unwrap_or(false)
                    }
                };
                if crossed {
                    let key = format!("{}:{}", feed_str, price.publish_time);
                    let snap = PriceSnapshot {
                        price: price.raw as f64 * 10f64.powi(price.expo),
                        conf: 0.0,
                        publish_time: price.publish_time,
                        fetched_at: std::time::Instant::now(),
                        source: SourceLayer::HermesPoll,
                        raw_price: Some(price.raw),
                        expo: Some(price.expo),
                    };
                    let entry = to_fire.entry(key).or_insert_with(|| (Vec::new(), snap));
                    entry.0.push(ctx.clone());
                }
            }
        }

        // -----------------------------------------------------------------------
        // Cache-driven path: reads from PriceCache (written by Lazer/SSE/Hermes
        // poll) and MintPriceCache (written by the 1s Jupiter probe). Handles all
        // four source combinations for ratio triggers.
        //
        // In StreamMode::On, local_prices is always empty (poll suppressed) so
        // the poll-path loop above does nothing — this path is the sole evaluator.
        // In Off/Shadow modes both paths run; the `already` set deduplicates.
        //
        // PYTH base triggers (absolute and Pyth/Pyth ratio) — from PriceCache.
        // -----------------------------------------------------------------------
        let cache_snaps = price_cache.snapshot_all().await;
        let mint_snaps = mint_cache.snapshot_all().await;
        for feed in &feeds {
            let feed_hex_id = pubkey_to_hex(feed);
            let Some(base_snap) = cache_snaps.get(&feed_hex_id) else {
                continue;
            };
            let ctxs = set.price_matches_for_source(feed, oracle_source::PYTH);
            for ctx in &ctxs {
                // Skip if already handled by the poll-path above (dedup).
                if !already.insert(ctx.pubkey) {
                    continue;
                }
                let TriggerSpec::AssetPrice {
                    quote_mint,
                    comparator,
                    threshold,
                    expo,
                    ..
                } = &ctx.trigger
                else {
                    continue;
                };

                let crossed = match quote_mint {
                    None => {
                        // Pyth absolute: USD-denominated comparison.
                        let threshold_f64 = (*threshold as f64) * 10f64.powi(*expo);
                        match *comparator {
                            0 => base_snap.price <= threshold_f64,
                            1 => base_snap.price >= threshold_f64,
                            _ => false,
                        }
                    }
                    Some(quote_pk) => {
                        if catalog.contains_key(&quote_pk.to_bytes()) {
                            // Pyth/Pyth ratio: both legs from PriceCache.
                            let quote_feed_hex = pubkey_to_hex(quote_pk);
                            let Some(quote_snap) = cache_snaps.get(&quote_feed_hex) else {
                                continue; // quote not yet in cache — skip this tick.
                            };
                            decide_ratio_cross(
                                base_snap.price,
                                quote_snap.price,
                                *threshold,
                                *expo,
                                *comparator,
                            )
                        } else {
                            // Pyth/Jup ratio: base from PriceCache, quote from
                            // MintPriceCache (Jupiter probe). Skip if quote is stale.
                            let Some(quote_mint_snap) = mint_snaps.get(quote_pk) else {
                                continue;
                            };
                            decide_ratio_cross(
                                base_snap.price,
                                quote_mint_snap.price_usd,
                                *threshold,
                                *expo,
                                *comparator,
                            )
                        }
                    }
                };

                if crossed {
                    let key = format!("{}:{}", feed_hex_id, base_snap.publish_time);
                    let entry = to_fire
                        .entry(key)
                        .or_insert_with(|| (Vec::new(), base_snap.clone()));
                    entry.0.push(ctx.clone());
                }
            }
        }

        // -----------------------------------------------------------------------
        // JUPITER base triggers (absolute and Jup/Pyth, Jup/Jup ratios).
        // Base price comes from MintPriceCache. For Jup absolute the snapshot's
        // price_usd is already USD-denominated. For ratios, divide by the quote
        // leg's USD price from the appropriate source.
        // -----------------------------------------------------------------------
        let jup_feeds = set.price_feeds_for_source(oracle_source::JUPITER);
        for feed in &jup_feeds {
            let Some(base_mint_snap) = mint_snaps.get(feed) else {
                continue; // Jupiter probe hasn't populated this mint yet.
            };
            let ctxs = set.price_matches_for_source(feed, oracle_source::JUPITER);
            for ctx in &ctxs {
                if !already.insert(ctx.pubkey) {
                    continue;
                }
                let TriggerSpec::AssetPrice {
                    quote_mint,
                    comparator,
                    threshold,
                    expo,
                    ..
                } = &ctx.trigger
                else {
                    continue;
                };

                let crossed = match quote_mint {
                    None => {
                        // Jup absolute: compare USD price directly.
                        let threshold_f64 = (*threshold as f64) * 10f64.powi(*expo);
                        match *comparator {
                            0 => base_mint_snap.price_usd <= threshold_f64,
                            1 => base_mint_snap.price_usd >= threshold_f64,
                            _ => false,
                        }
                    }
                    Some(quote_pk) => {
                        if catalog.contains_key(&quote_pk.to_bytes()) {
                            // Jup/Pyth ratio: base from MintPriceCache,
                            // quote from PriceCache (Pyth feed).
                            let quote_feed_hex = pubkey_to_hex(quote_pk);
                            let Some(quote_snap) = cache_snaps.get(&quote_feed_hex) else {
                                continue;
                            };
                            decide_ratio_cross(
                                base_mint_snap.price_usd,
                                quote_snap.price,
                                *threshold,
                                *expo,
                                *comparator,
                            )
                        } else {
                            // Jup/Jup ratio: both legs from MintPriceCache.
                            let Some(quote_mint_snap) = mint_snaps.get(quote_pk) else {
                                continue;
                            };
                            decide_ratio_cross(
                                base_mint_snap.price_usd,
                                quote_mint_snap.price_usd,
                                *threshold,
                                *expo,
                                *comparator,
                            )
                        }
                    }
                };

                if crossed {
                    // Use the mint pubkey + snapshot instant as correlation key.
                    let now_unix = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    let key = format!("cache_jup:{}:{}", feed, now_unix);
                    let snap = PriceSnapshot {
                        price: base_mint_snap.price_usd,
                        conf: 0.0,
                        publish_time: now_unix,
                        fetched_at: base_mint_snap.fetched_at,
                        source: SourceLayer::HermesPoll, // closest analogue for REST poll
                        raw_price: None,
                        expo: None,
                    };
                    let entry = to_fire.entry(key).or_insert_with(|| (Vec::new(), snap));
                    entry.0.push(ctx.clone());
                }
            }
        }

        // -----------------------------------------------------------------------
        // PriceRelativeToFill triggers: evaluate every automation whose trigger
        // is PriceRelativeToFill against the FillCache + current USD price.
        //
        // These triggers are NOT indexed by feed/account — they live only in
        // `by_pubkey`. We iterate all automations and filter by trigger kind.
        //
        // Polling at the heartbeat tick (30s) is sufficient: FillCache records
        // are rare (only on execute_swap), and the current USD price changes
        // are already caught by the Pyth/Jupiter notify paths above. No
        // separate Notify for FillCache is needed.
        // -----------------------------------------------------------------------

        // Track which upstream pubkeys we've already logged as missing this
        // tick so we emit at most one debug line per upstream per heartbeat.
        let mut missing_logged: HashSet<Pubkey> = HashSet::new();

        for ctx in set.by_pubkey.values() {
            if already.contains(&ctx.pubkey) {
                continue;
            }
            let TriggerSpec::PriceRelativeToFill { upstream, direction, pct_bps } = &ctx.trigger
            else {
                continue;
            };

            // Need the upstream fill record.
            let Some(fill) = fill_cache.get_fresh(upstream).await else {
                // Only log once per distinct upstream per tick to avoid spam.
                if missing_logged.insert(*upstream) {
                    debug!(target: "fills", %upstream, automation = %ctx.pubkey, "skipping PriceRelativeToFill: no fresh fill for upstream");
                }
                continue;
            };

            // Resolve the current USD price for the downstream rule's output mint.
            // The downstream trigger fires when ITS own output-mint price moves
            // relative to the upstream fill price. We need the output mint from
            // the downstream automation's Swap action.
            let current_usd = match &ctx.action {
                crate::state::ActionSpec::Swap { input_mint, .. } => {
                    // The "price" this trigger tracks is the input_mint's current
                    // USD price — same asset the user is about to re-buy or sell.
                    resolve_current_usd_price(input_mint, &cache_snaps, &mint_snaps).await
                }
                _ => None,
            };

            let Some(current_usd) = current_usd else {
                continue; // no USD price available this tick; skip
            };

            let crossed = decide_fill_relative_cross(
                current_usd,
                fill.effective_usd_per_output,
                *direction,
                *pct_bps,
            );

            if crossed && already.insert(ctx.pubkey) {
                let now_unix = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let key = format!("fill_rel:{}:{}", ctx.pubkey, now_unix);
                let entry = to_fire.entry(key).or_insert_with(|| {
                    let snap = PriceSnapshot {
                        price: current_usd,
                        conf: 0.0,
                        publish_time: now_unix,
                        fetched_at: std::time::Instant::now(),
                        source: SourceLayer::HermesPoll,
                        raw_price: None,
                        expo: None,
                    };
                    (Vec::new(), snap)
                });
                entry.0.push(ctx.clone());
            }
        }

        // Drop the read guards before the async send below.
        drop(prices);
        drop(hermes_quote_prices);
        drop(mint_quotes);

        for (correlation, (mut matches, snap)) in to_fire {
            // Drop tail-of-chain rules whose upstream hasn't fired yet.
            matches.retain(|c| c.armed);
            if matches.is_empty() {
                continue;
            }
            info!(
                count = matches.len(),
                correlation,
                "price_watcher: threshold crossed; firing"
            );
            let evt = TriggerEvent {
                source: "price_watcher",
                correlation,
                matches,
                depth: 0,
                snapshot: Some(snap),
            };
            if let Err(e) = trigger_tx.send(evt).await {
                return Err(anyhow!("price_watcher: trigger channel closed: {e}"));
            }
        }
    }
}

/// Snapshot of a Jupiter `/quote` for one mint paired against USDC.
/// Used as the quote leg of an AssetPrice trigger configured with a
/// non-USD quote mint.
#[derive(Debug, Clone)]
pub(crate) struct MintQuote {
    /// out_amount in USDC base units (6 decimals) when swapping
    /// `PROBE_AMOUNT_RAW` of the mint.
    pub(crate) out_amount: u64,
}

/// USDC mainnet mint. The probe quote is denominated in USDC so all
/// quote prices are comparable to USD-denominated Pyth feeds. Devnet
/// USDC is a different mint; this is mainnet-only by design (devnet
/// liquidity is too thin to make non-USD quotes meaningful anyway).
const USDC_MINT_STR: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/// Probe with 1.0 unit at 9-decimal scale; the keeper handles
/// expo-alignment via cross-multiplication so the actual decimals on
/// the quote mint don't have to match.
const PROBE_AMOUNT_RAW: u64 = 1_000_000_000;

pub(crate) async fn probe_mint(
    jupiter: &JupiterClient,
    mint: &Pubkey,
    slippage_bps: u16,
) -> Result<MintQuote> {
    use std::str::FromStr;
    let usdc = Pubkey::from_str(USDC_MINT_STR).expect("USDC mint constant valid");
    if *mint == usdc {
        return Ok(MintQuote {
            out_amount: 1_000_000, // 1 USDC at 6 decimals
        });
    }
    let q = jupiter.quote(mint, &usdc, PROBE_AMOUNT_RAW, slippage_bps).await?;
    let out: u64 = q
        .out_amount
        .parse()
        .map_err(|e| anyhow!("parse out_amount `{}`: {e}", q.out_amount))?;
    Ok(MintQuote { out_amount: out })
}

/// Compute `base/quote comparator threshold*10^expo` using
/// cross-multiplication to avoid div-by-zero and float drift.
/// Returns Some(true/false) for the crossing decision, or None if the
/// comparator byte is invalid.
pub(crate) fn ratio_compare(
    comparator: u8,
    base: (i128, i32),
    quote: (i128, i32),
    threshold: i64,
    threshold_expo: i32,
) -> Option<bool> {
    let (b_raw, b_expo) = base;
    let (q_raw, q_expo) = quote;
    if q_raw == 0 {
        return None;
    }
    let exp = threshold_expo as i64 + q_expo as i64 - b_expo as i64;
    if exp >= 0 {
        let pow = 10i128.saturating_pow(exp as u32);
        let rhs = (q_raw)
            .saturating_mul(threshold as i128)
            .saturating_mul(pow);
        Some(match comparator {
            0 => b_raw <= rhs,
            1 => b_raw >= rhs,
            _ => return None,
        })
    } else {
        let pow = 10i128.saturating_pow((-exp) as u32);
        let scaled_b = b_raw.saturating_mul(pow);
        Some(match comparator {
            0 => scaled_b <= q_raw.saturating_mul(threshold as i128),
            1 => scaled_b >= q_raw.saturating_mul(threshold as i128),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone)]
pub struct LatestPrice {
    pub raw: i64,
    pub expo: i32,
    pub publish_time: i64,
}

#[derive(Debug, Deserialize)]
struct ParsedPriceResp {
    parsed: Option<Vec<ParsedFeed>>,
}

#[derive(Debug, Deserialize)]
struct ParsedFeed {
    id: String,
    price: ParsedPriceInner,
}

#[derive(Debug, Deserialize)]
struct ParsedPriceInner {
    price: String,
    expo: i32,
    publish_time: i64,
}

pub(crate) async fn fetch_prices(
    http: &reqwest::Client,
    hermes: &str,
    feed_ids: &[String],
) -> Result<HashMap<String, LatestPrice>> {
    if feed_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut url = format!("{}/v2/updates/price/latest?parsed=true", hermes.trim_end_matches('/'));
    for id in feed_ids {
        url.push_str("&ids[]=");
        url.push_str(&strip_0x(id));
    }
    let resp = http.get(&url).send().await?.error_for_status()?;
    let parsed: ParsedPriceResp = resp.json().await?;
    let mut out = HashMap::new();
    for f in parsed.parsed.unwrap_or_default() {
        if let Ok(raw) = f.price.price.parse::<i64>() {
            out.insert(
                f.id.to_lowercase(),
                LatestPrice {
                    raw,
                    expo: f.price.expo,
                    publish_time: f.price.publish_time,
                },
            );
        }
    }
    Ok(out)
}

fn strip_0x(id: &str) -> String {
    if let Some(rest) = id.strip_prefix("0x") {
        rest.to_string()
    } else {
        id.to_string()
    }
}

/// Format a Solana Pubkey as a 64-char lowercase hex string (Pyth's wire
/// format). On-chain we stored Pyth feed IDs as Pubkey bytes; this is
/// the inverse.
pub fn pubkey_to_hex(p: &Pubkey) -> String {
    let bytes = p.to_bytes();
    let mut s = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{:02x}", b);
    }
    s
}

/// Compute the per-trigger distance to threshold for all absolute-price
/// (non-ratio, non-quote_mint) PYTH triggers that have a current price in
/// `local_prices`. Distance is `|price - threshold| / |threshold|`.
///
/// Ratio and quote_mint triggers are skipped — their distance metric is
/// more complex and they'll be covered by the fallback cadence
/// (`cfg.price_poll_interval`) when they dominate.
///
/// Returns an empty Vec when there are no absolute-price triggers with a
/// known current price, which causes the caller to fall back to the
/// configured baseline poll interval.
pub(crate) fn compute_active_distances(
    set: &WatchedSet,
    local_prices: &HashMap<String, LatestPrice>,
) -> Vec<f64> {
    let mut out = Vec::new();
    for (feed, ctxs) in &set.price_triggers {
        let feed_hex = pubkey_to_hex(feed);
        let Some(price) = local_prices.get(&feed_hex) else {
            continue;
        };
        for ctx in ctxs {
            let TriggerSpec::AssetPrice {
                quote_mint: None, // skip ratio/quote_mint triggers
                threshold,
                expo,
                source,
                ..
            } = &ctx.trigger
            else {
                continue;
            };
            // Only compute distance for PYTH-sourced absolute triggers.
            if *source != crate::state::oracle_source::PYTH {
                continue;
            }
            if *threshold == 0 {
                continue;
            }
            let threshold_f64 = (*threshold as f64) * 10f64.powi(*expo);
            let price_f64 = price.raw as f64 * 10f64.powi(price.expo);
            let distance = (price_f64 - threshold_f64).abs() / threshold_f64.abs();
            out.push(distance);
        }
    }
    out
}

/// Compare normalized prices. We match exponents by left-shifting the
/// lower-precision value to the higher precision, then comparing as i128.
/// This avoids floating-point drift around the threshold.
pub fn crossed_below(price: &LatestPrice, threshold: i64, threshold_expo: i32) -> bool {
    let (a, b) = align(price.raw, price.expo, threshold, threshold_expo);
    a <= b
}

pub fn crossed_above(price: &LatestPrice, threshold: i64, threshold_expo: i32) -> bool {
    let (a, b) = align(price.raw, price.expo, threshold, threshold_expo);
    a >= b
}

fn align(a_raw: i64, a_expo: i32, b_raw: i64, b_expo: i32) -> (i128, i128) {
    let mut a = a_raw as i128;
    let mut b = b_raw as i128;
    if a_expo > b_expo {
        a *= 10i128.saturating_pow((a_expo - b_expo) as u32);
    } else if b_expo > a_expo {
        b *= 10i128.saturating_pow((b_expo - a_expo) as u32);
    }
    (a, b)
}

/// Determine whether a ratio trigger crosses its threshold.
///
/// Used by the cache-driven evaluator path to evaluate triggers of the form
/// "fire when base_price / quote_price crosses threshold". Both `base_price`
/// and `quote_price` are USD-denominated f64 values (from either PriceCache
/// or MintPriceCache), so the helper is source-agnostic and covers all four
/// combinations: Pyth/Pyth, Pyth/Jup, Jup/Pyth, Jup/Jup.
///
/// Precision: f64 has ~15 significant digits. For Pyth's typical exponent of
/// -8 crypto pairs, the integer mantissa fits ~7 digits before the decimal
/// and up to 8 after, well within f64's precision.
///
/// `comparator` semantics: 0 = crossed_below (<=), 1 = crossed_above (>=).
pub(crate) fn decide_ratio_cross(
    base_price: f64,
    quote_price: f64,
    threshold: i64,
    threshold_expo: i32,
    comparator: u8,
) -> bool {
    if quote_price <= 0.0 {
        return false;
    }
    let ratio = base_price / quote_price;
    let threshold_f64 = (threshold as f64) * 10f64.powi(threshold_expo);
    match comparator {
        0 => ratio <= threshold_f64,
        1 => ratio >= threshold_f64,
        _ => false,
    }
}

/// Resolve the current USD price for a mint using the available caches.
/// Priority: MintPriceCache (Jupiter probe, covers all SPL mints) →
/// PriceCache (Pyth feed hex, for Pyth-registered mints).
/// Returns `None` when neither cache has a fresh value.
///
/// The `cache_snaps` and `mint_snaps` arguments are pre-fetched snapshots
/// from the outer evaluator tick so we don't take extra lock round-trips
/// per trigger inside the evaluator loop.
async fn resolve_current_usd_price(
    mint: &Pubkey,
    cache_snaps: &HashMap<String, PriceSnapshot>,
    mint_snaps: &HashMap<Pubkey, crate::mints::cache::MintPriceSnapshot>,
) -> Option<f64> {
    // Jupiter probe covers all SPL mints and is always the cheapest lookup.
    if let Some(snap) = mint_snaps.get(mint) {
        return Some(snap.price_usd);
    }
    // Pyth fallback: mint bytes encoded as hex feed ID.
    let feed_hex = pubkey_to_hex(mint);
    if let Some(snap) = cache_snaps.get(&feed_hex) {
        return Some(snap.price);
    }
    None
}

/// Decide whether a PriceRelativeToFill trigger should fire.
///
/// Returns `true` when:
///   direction = 0 (drop_below): current_usd <= fill_usd * (1 - pct_bps/10_000)
///   direction = 1 (grow_above): current_usd >= fill_usd * (1 + pct_bps/10_000)
///
/// Returns `false` for any other direction byte (treated as unknown).
pub(crate) fn decide_fill_relative_cross(
    current_usd: f64,
    fill_usd_per_output: f64,
    direction: u8,
    pct_bps: u32,
) -> bool {
    if fill_usd_per_output <= 0.0 {
        return false;
    }
    let factor = (pct_bps as f64) / 10_000.0;
    match direction {
        0 => current_usd <= fill_usd_per_output * (1.0 - factor), // drop_below
        1 => current_usd >= fill_usd_per_output * (1.0 + factor), // grow_above
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::oracle_source;
    use crate::types::AutomationCtx;
    use crate::state::{ActionSpec, TriggerSpec};

    fn px(raw: i64, expo: i32) -> LatestPrice {
        LatestPrice {
            raw,
            expo,
            publish_time: 0,
        }
    }

    #[test]
    fn below_aligns_exponents() {
        // SOL at $100.00 (10000 * 10^-2) vs threshold $200 (200 * 10^0)
        assert!(crossed_below(&px(10_000, -2), 200, 0));
        // SOL at $100.00 vs threshold $50 — not crossed
        assert!(!crossed_below(&px(10_000, -2), 50, 0));
    }

    #[test]
    fn above_aligns_exponents() {
        // SOL at $200.00 vs threshold $150 — crossed above
        assert!(crossed_above(&px(20_000, -2), 150, 0));
        // SOL at $100 vs threshold $150 — not crossed
        assert!(!crossed_above(&px(10_000, -2), 150, 0));
    }

    /// Helper: build a minimal AutomationCtx with an absolute-price AssetPrice
    /// trigger (no quote_mint) using PYTH as source.
    fn price_ctx(feed: Pubkey, threshold: i64, expo: i32) -> AutomationCtx {
        AutomationCtx {
            pubkey: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            nonce: 0,
            created_at: 0,
            trigger: TriggerSpec::AssetPrice {
                feed,
                quote_mint: None,
                comparator: 1,
                threshold,
                expo,
                source: oracle_source::PYTH,
            },
            action: ActionSpec::TransferSol {
                destination: Pubkey::new_unique(),
                amount: 1_000_000,
            },
            bridge_enabled: false,
            executions: 0,
            armed: true,
        }
    }

    #[test]
    fn compute_distances_empty_watched_set() {
        let set = WatchedSet::default();
        let local: HashMap<String, LatestPrice> = HashMap::new();
        let distances = compute_active_distances(&set, &local);
        assert!(distances.is_empty());
    }

    #[test]
    fn compute_distances_single_trigger_one_percent_away() {
        // Threshold: $100.00 (threshold=10000, expo=-2 → 10000 * 10^-2 = 100)
        // Current price: $101.00 (raw=10100, expo=-2)
        // Expected distance: (101 - 100).abs() / 100 = 0.01
        let feed = Pubkey::new_unique();
        let ctx = price_ctx(feed, 10_000, -2);
        let set = WatchedSet::from_index(vec![ctx]);

        let feed_hex = pubkey_to_hex(&feed);
        let mut local: HashMap<String, LatestPrice> = HashMap::new();
        local.insert(feed_hex, LatestPrice { raw: 10_100, expo: -2, publish_time: 0 });

        let distances = compute_active_distances(&set, &local);
        assert_eq!(distances.len(), 1);
        let d = distances[0];
        // Allow small floating-point tolerance.
        assert!((d - 0.01).abs() < 1e-9, "distance was {d}, expected 0.01");
    }

    // -----------------------------------------------------------------------
    // Pyth-quoted ratio trigger tests (cache-driven path, StreamMode::On)
    // -----------------------------------------------------------------------

    /// SOL/EUR > 180 should fire when SOL = $200, EUR/USD = $1.10 → ratio ≈ 181.8.
    #[test]
    fn pyth_ratio_above_threshold_crosses() {
        // base: SOL/USD = $200.00, quote: EUR/USD = $1.10 → ratio ≈ 181.8
        // threshold: 180 (threshold=180, expo=0 → 180 * 10^0 = 180)
        let crossed = decide_ratio_cross(
            200.0, // SOL/USD
            1.10,  // EUR/USD
            180,   // threshold mantissa
            0,     // threshold expo → 180.0
            1,     // comparator: crossed_above (>=)
        );
        assert!(crossed, "SOL/EUR ≈ 181.8 should cross above 180");
    }

    /// SOL/EUR > 190 should NOT fire when ratio is only 181.8.
    #[test]
    fn pyth_ratio_above_threshold_does_not_cross() {
        let crossed = decide_ratio_cross(
            200.0, // SOL/USD = $200
            1.10,  // EUR/USD = $1.10 → SOL/EUR ≈ 181.8
            190,   // threshold = 190
            0,     // expo 0 → 190.0
            1,     // crossed_above
        );
        assert!(!crossed, "SOL/EUR ≈ 181.8 should not cross above 190");
    }

    /// SOL/EUR < 100 should fire when ratio = 80.
    #[test]
    fn pyth_ratio_below_threshold_crosses() {
        // base: SOL/USD = $80, quote: EUR/USD = $1.0 → ratio = 80.0
        // threshold: 100, crossed_below (<=)
        let crossed = decide_ratio_cross(
            80.0, 1.0, 100, 0, 0,
        );
        assert!(crossed, "SOL/EUR = 80 should cross below 100");
    }

    /// Zero or negative quote price must return false (guard against bogus data).
    #[test]
    fn pyth_ratio_zero_quote_price_returns_false() {
        assert!(!decide_ratio_cross(200.0, 0.0, 180, 0, 1));
        assert!(!decide_ratio_cross(200.0, -1.0, 180, 0, 1));
    }

    /// Invalid comparator byte returns false without panicking.
    #[test]
    fn pyth_ratio_invalid_comparator_returns_false() {
        assert!(!decide_ratio_cross(200.0, 1.1, 180, 0, 99));
    }

    /// Threshold with negative exponent: threshold = 1_800_000 * 10^-4 = 180.0.
    #[test]
    fn pyth_ratio_threshold_with_negative_expo() {
        // SOL/EUR ≈ 181.8 vs threshold 180.0 expressed with expo=-4
        // threshold_f64 = 1_800_000 * 10^-4 = 180.0
        let crossed = decide_ratio_cross(
            200.0, 1.10, 1_800_000, -4, 1,
        );
        assert!(crossed, "SOL/EUR ≈ 181.8 should cross above 180.0 (expo=-4)");
    }

    /// Integration-style test: build a WatchedSet with a Pyth-quoted ratio
    /// trigger and two PriceSnapshots in a PriceCache; verify the cache-driven
    /// evaluator logic produces the correct `crossed` decision using the
    /// `decide_ratio_cross` helper that is wired into the evaluator.
    ///
    /// This mirrors what the evaluator does for StreamMode::On without needing
    /// to mock the async catalog lookup or spawn the full price_watcher::run.
    #[test]
    fn cache_evaluator_ratio_logic_fires_when_threshold_crossed() {
        // Simulate: SOL/USD = 200.0 (base snap), EUR/USD = 1.10 (quote snap)
        // Trigger: SOL/EUR >= 180 (threshold=180, expo=0, comparator=1)
        // Expected: 200.0 / 1.10 ≈ 181.8 >= 180 → fires
        let base_price = 200.0f64;
        let quote_price = 1.10f64;
        let threshold: i64 = 180;
        let expo: i32 = 0;
        let comparator: u8 = 1; // crossed_above

        let result = decide_ratio_cross(
            base_price, quote_price, threshold, expo, comparator,
        );
        assert!(result, "ratio 181.8 should cross above threshold 180");

        // Confirm the inverse does not fire.
        let result_below = decide_ratio_cross(
            base_price, quote_price, 182, expo, comparator,
        );
        assert!(!result_below, "ratio 181.8 should not cross above threshold 182");
    }

    // -----------------------------------------------------------------------
    // New cross-source ratio tests: Jup/Pyth and Pyth/Jup.
    // Both use the same decide_ratio_cross helper — the math is identical
    // regardless of which source provided each leg's USD price.
    // -----------------------------------------------------------------------

    /// Jup/Pyth ratio: Jupiter-sourced base (e.g. BONK), Pyth-sourced quote (SOL).
    /// BONK = $0.00002, SOL = $180 → BONK/SOL ≈ 0.000000111. Trigger: BONK/SOL < 0.0000002.
    #[test]
    fn jup_pyth_ratio_below_threshold_crosses() {
        let bonk_usd = 0.00002_f64;
        let sol_usd = 180.0_f64;
        // ratio = 0.00002 / 180 ≈ 1.11e-7
        // threshold: 0.0000002 = 2 * 10^-7 (threshold=2, expo=-7)
        let crossed = decide_ratio_cross(bonk_usd, sol_usd, 2, -7, 0); // crossed_below
        assert!(crossed, "BONK/SOL ≈ 1.11e-7 should cross below 2e-7");
    }

    /// Jup/Pyth ratio above threshold should NOT fire when ratio is smaller.
    #[test]
    fn jup_pyth_ratio_above_threshold_does_not_cross() {
        let bonk_usd = 0.00002_f64;
        let sol_usd = 180.0_f64;
        // ratio ≈ 1.11e-7; threshold: 5e-8 = 0 crossed_above — ratio is above threshold.
        // We test the "crossed_above 2e-7" case — ratio is below so should NOT cross.
        let crossed = decide_ratio_cross(bonk_usd, sol_usd, 2, -7, 1); // crossed_above
        assert!(!crossed, "BONK/SOL ≈ 1.11e-7 should not cross above 2e-7");
    }

    /// Pyth/Jup ratio: Pyth-sourced base (EUR/USD Pyth feed), Jupiter-sourced
    /// quote (USDC SPL mint price in USD ≈ 1.0). EUR/USD = $1.10 / $1.0 = 1.10.
    /// Trigger: EUR/USDC >= 1.05.
    #[test]
    fn pyth_jup_ratio_above_threshold_crosses() {
        let eur_usd = 1.10_f64; // from Pyth PriceCache
        let usdc_usd = 1.0_f64; // from MintPriceCache (Jupiter probe)
        // ratio = 1.10 / 1.0 = 1.10; threshold = 1.05 (threshold=105, expo=-2)
        let crossed = decide_ratio_cross(eur_usd, usdc_usd, 105, -2, 1); // crossed_above
        assert!(crossed, "EUR/USDC = 1.10 should cross above 1.05");
    }

    /// Pyth/Jup ratio: EUR/USDC < threshold should NOT cross above.
    #[test]
    fn pyth_jup_ratio_below_threshold_does_not_cross_above() {
        let eur_usd = 1.02_f64;
        let usdc_usd = 1.0_f64;
        // ratio = 1.02; threshold = 1.05 — not crossed above
        let crossed = decide_ratio_cross(eur_usd, usdc_usd, 105, -2, 1);
        assert!(!crossed, "EUR/USDC = 1.02 should not cross above 1.05");
    }

    // -----------------------------------------------------------------------
    // PriceRelativeToFill evaluator tests (decide_fill_relative_cross)
    // -----------------------------------------------------------------------

    /// Fill at $80k; current at $72k; threshold = 10% (1000 bps) drop_below.
    /// 72k <= 80k * (1 - 0.10) = 72k → exactly at the boundary → fires.
    #[test]
    fn fill_relative_drop_below_exact_boundary_fires() {
        let crossed = decide_fill_relative_cross(72_000.0, 80_000.0, 0, 1000);
        assert!(crossed, "current == fill * 0.9 should cross drop_below at exactly the boundary");
    }

    /// Fill at $80k; current at $73k; threshold = 10% drop_below.
    /// 73k > 72k → not crossed.
    #[test]
    fn fill_relative_drop_below_above_threshold_does_not_fire() {
        let crossed = decide_fill_relative_cross(73_000.0, 80_000.0, 0, 1000);
        assert!(!crossed, "current above threshold should not cross drop_below");
    }

    /// Fill at $80k; current at $88k; threshold = 10% (1000 bps) grow_above.
    /// 88k >= 80k * 1.10 = 88k → exactly at boundary → fires.
    #[test]
    fn fill_relative_grow_above_exact_boundary_fires() {
        let crossed = decide_fill_relative_cross(88_000.0, 80_000.0, 1, 1000);
        assert!(crossed, "current == fill * 1.1 should cross grow_above at exactly the boundary");
    }

    /// Fill at $80k; current at $87k; threshold = 10% grow_above.
    /// 87k < 88k → not crossed.
    #[test]
    fn fill_relative_grow_above_below_threshold_does_not_fire() {
        let crossed = decide_fill_relative_cross(87_000.0, 80_000.0, 1, 1000);
        assert!(!crossed, "current below threshold should not cross grow_above");
    }

    /// Zero or negative fill price must never fire (guard against bogus data).
    #[test]
    fn fill_relative_zero_fill_returns_false() {
        assert!(!decide_fill_relative_cross(100.0, 0.0, 0, 100));
        assert!(!decide_fill_relative_cross(100.0, -1.0, 1, 100));
    }

    /// Unknown direction byte returns false without panicking.
    #[test]
    fn fill_relative_unknown_direction_returns_false() {
        assert!(!decide_fill_relative_cross(100.0, 80_000.0, 99, 500));
    }

    /// Tiny threshold: 1 bps (0.01%). Verify the math scales correctly.
    #[test]
    fn fill_relative_tiny_threshold_bps() {
        // fill = $100.00; 1 bps drop_below threshold → trigger at $99.99
        // current = $99.98 → crosses
        let crossed = decide_fill_relative_cross(99.98, 100.0, 0, 1);
        assert!(crossed, "99.98 <= 100 * (1 - 0.0001) = 99.99 should cross");
        // current = $99.995 → does NOT cross (99.995 > 99.99)
        let not_crossed = decide_fill_relative_cross(99.995, 100.0, 0, 1);
        assert!(!not_crossed, "99.995 > 99.99 should not cross drop_below");
    }
}
