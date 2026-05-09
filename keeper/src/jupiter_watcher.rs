//! Jupiter Price API watcher.
//!
//! Sibling to `price_watcher` (Pyth Hermes) and `lazer_watcher` (Pyth
//! Lazer). Polls Jupiter Price API v3 for AssetPrice triggers whose
//! `source = oracle_source::JUPITER`. The on-chain `feed: Pubkey` field
//! carries the SPL mint pubkey for these triggers (Jupiter prices are
//! keyed by mint, not by Pyth feed id).
//!
//! This module exists so the keeper can fire on tokens that don't have a
//! Pyth feed — long-tail tokens, freshly-launched mints — without the
//! frontend having to detect that and fall back to "switchboard_pending".
//!
//! Adding a new oracle (Switchboard, Chainlink, …) follows the same
//! shape: new `<provider>_watcher.rs` file, one `tokio::spawn` line in
//! `main.rs`, one source byte in `state::oracle_source`. No on-chain
//! schema change.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use solana_sdk::pubkey::Pubkey;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;
use crate::price_watcher::{crossed_above, crossed_below, LatestPrice};
use crate::state::{oracle_source, TriggerSpec};
use crate::types::{AutomationCtx, TriggerEvent};

/// Jupiter responses keyed by mint string. We only deserialize the
/// `usdPrice` field — Jupiter returns several others (decimals,
/// lastUpdated, …) we don't currently use.
#[derive(Debug, Deserialize)]
struct PriceEntry {
    #[serde(rename = "usdPrice")]
    usd_price: Option<f64>,
}

/// Jupiter Price API publishes USD prices as f64. We normalize to the
/// keeper's wire format `(raw: i64, expo: i32)` at a fixed exponent of
/// `-6` so the comparison helpers (`crossed_below`/`crossed_above` /
/// `ratio_compare`) stay source-agnostic. -6 = 1e6 = USDC's native
/// decimals; covers tokens up to ~$9.2 trillion in price (i64 max /
/// 1e6) without precision loss.
const JUPITER_PRICE_EXPO: i32 = -6;
const JUPITER_PRICE_SCALE: f64 = 1_000_000.0;

/// Cap on how many mints we cram into a single `/price/v3?ids=...` call.
/// Jupiter's URL limit is around 8 KB and a base58 mint is ~44 chars;
/// 100 fits with margin to spare.
const PRICE_BATCH_SIZE: usize = 100;

pub async fn run(
    cfg: Arc<KeeperConfig>,
    set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
) -> Result<()> {
    if !cfg.jupiter_price_enabled {
        info!("jupiter_watcher: disabled by config; not polling");
        return Ok(());
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()?;
    let mut tick = interval(cfg.price_poll_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    info!(
        endpoint = %cfg.jupiter_price_url,
        cadence_secs = cfg.price_poll_interval.as_secs(),
        api_key = if cfg.jupiter_api_key.is_some() { "set" } else { "unset" },
        "jupiter_watcher: starting Jupiter Price v3 poller",
    );

    loop {
        tick.tick().await;
        let set = set_rx.borrow().clone();
        let mints: Vec<Pubkey> = set.price_feeds_for_source(oracle_source::JUPITER);
        if mints.is_empty() {
            continue;
        }

        debug!(count = mints.len(), "jupiter_watcher: polling");
        let prices = match fetch_prices_batched(
            &http,
            &cfg.jupiter_price_url,
            cfg.jupiter_api_key.as_deref(),
            &mints,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "jupiter_watcher: price fetch failed");
                continue;
            }
        };
        if prices.is_empty() {
            continue;
        }

        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let mut to_fire: HashMap<String, Vec<AutomationCtx>> = HashMap::new();
        let mut already: HashSet<Pubkey> = HashSet::new();

        for mint in &mints {
            let Some(price) = prices.get(mint) else {
                continue;
            };
            let latest = LatestPrice {
                raw: *price,
                expo: JUPITER_PRICE_EXPO,
                publish_time: now_unix,
            };
            let ctxs = set.price_matches_for_source(mint, oracle_source::JUPITER);
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
                // USD-quote only. Jupiter natively prices in USD; pair
                // ratios with a non-USD quote_mint aren't supported on
                // this watcher (the frontend already restricts non-USD
                // quotes to mint-bearing assets, and those go through
                // price_watcher's Jupiter `/quote` probe).
                if quote_mint.is_some() {
                    continue;
                }
                let crossed = match *comparator {
                    0 => crossed_below(&latest, *threshold, *expo),
                    1 => crossed_above(&latest, *threshold, *expo),
                    _ => false,
                };
                if crossed {
                    let key = format!("jupiter:{}:{now_unix}", mint);
                    to_fire.entry(key).or_default().push(ctx.clone());
                }
            }
        }

        for (correlation, matches) in to_fire {
            info!(
                count = matches.len(),
                correlation,
                "jupiter_watcher: threshold crossed; firing"
            );
            let evt = TriggerEvent {
                source: "jupiter_watcher",
                correlation,
                matches,
                depth: 0,
            };
            if let Err(e) = trigger_tx.send(evt).await {
                return Err(anyhow!("jupiter_watcher: trigger channel closed: {e}"));
            }
        }
    }
}

/// Fetch USD prices for `mints`, batched to keep URL length sane.
/// Returns mint → raw price (scaled to `JUPITER_PRICE_EXPO`).
async fn fetch_prices_batched(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    mints: &[Pubkey],
) -> Result<HashMap<Pubkey, i64>> {
    let mut out = HashMap::with_capacity(mints.len());
    for chunk in mints.chunks(PRICE_BATCH_SIZE) {
        let prices = fetch_prices(http, base_url, api_key, chunk).await?;
        out.extend(prices);
    }
    Ok(out)
}

async fn fetch_prices(
    http: &reqwest::Client,
    base_url: &str,
    api_key: Option<&str>,
    mints: &[Pubkey],
) -> Result<HashMap<Pubkey, i64>> {
    if mints.is_empty() {
        return Ok(HashMap::new());
    }
    let ids = mints
        .iter()
        .map(|m| m.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let url = format!(
        "{base}?ids={ids}",
        base = base_url.trim_end_matches('/'),
    );

    let mut req = http.get(&url);
    if let Some(key) = api_key {
        req = req.header("x-api-key", key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("jupiter price GET: {e}"))?
        .error_for_status()
        .map_err(|e| anyhow!("jupiter price status: {e}"))?;

    let map: HashMap<String, PriceEntry> = resp
        .json()
        .await
        .map_err(|e| anyhow!("jupiter price decode: {e}"))?;

    let mut out = HashMap::with_capacity(map.len());
    for (mint_str, entry) in map {
        let Some(usd) = entry.usd_price else { continue };
        if !usd.is_finite() || usd <= 0.0 {
            continue;
        }
        let Ok(mint) = mint_str.parse::<Pubkey>() else {
            continue;
        };
        let scaled = usd * JUPITER_PRICE_SCALE;
        if scaled.is_nan() || scaled > i64::MAX as f64 {
            continue;
        }
        out.insert(mint, scaled.round() as i64);
    }
    Ok(out)
}
