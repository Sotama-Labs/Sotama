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
use crate::price_watcher::{
    crossed_above, crossed_below, fetch_prices as fetch_pyth_prices, pubkey_to_hex, ratio_compare,
    LatestPrice,
};
use crate::prices::cache::{PriceSnapshot, SourceLayer};
use crate::pyth_catalog::{PythCatalog, PythCatalogHandle};
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
    // Shared Pyth catalog handle. Refreshed every 5 minutes by a background
    // task in main.rs; a snapshot is taken each poll tick so newly-listed
    // Pyth feeds are picked up without restarting the keeper.
    pyth_catalog: PythCatalogHandle,
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
        let base_mints: Vec<Pubkey> = set.price_feeds_for_source(oracle_source::JUPITER);
        // Snapshot the catalog once per tick so newly-listed Pyth feeds are
        // recognized as soon as the background refresher swaps them in.
        let catalog: PythCatalog = pyth_catalog.snapshot().await;
        if base_mints.is_empty() {
            continue;
        }

        // Partition quote_mints by dispatch:
        //   • Catalog hit → Pyth feed id, fetched from Hermes.
        //   • Miss        → SPL mint, fetched from Jupiter alongside bases.
        // Pyth feed ids and SPL mints are both 32 bytes; the catalog is
        // the only reliable disambiguator.
        let mut jupiter_mints: Vec<Pubkey> = base_mints.clone();
        let mut seen: HashSet<Pubkey> = base_mints.iter().copied().collect();
        let mut hermes_quote_pubkeys: Vec<Pubkey> = Vec::new();
        let mut hermes_seen: HashSet<Pubkey> = HashSet::new();
        for base in &base_mints {
            for ctx in &set.price_matches_for_source(base, oracle_source::JUPITER) {
                if let TriggerSpec::AssetPrice {
                    quote_mint: Some(qm),
                    ..
                } = &ctx.trigger
                {
                    if catalog.contains_key(&qm.to_bytes()) {
                        if hermes_seen.insert(*qm) {
                            hermes_quote_pubkeys.push(*qm);
                        }
                    } else if seen.insert(*qm) {
                        jupiter_mints.push(*qm);
                    }
                }
            }
        }

        debug!(
            jupiter = jupiter_mints.len(),
            hermes_quotes = hermes_quote_pubkeys.len(),
            "jupiter_watcher: polling",
        );
        let prices = match fetch_prices_batched(
            &http,
            &cfg.jupiter_price_url,
            cfg.jupiter_api_key.as_deref(),
            &jupiter_mints,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "jupiter_watcher: price fetch failed");
                continue;
            }
        };
        if prices.is_empty() && hermes_quote_pubkeys.is_empty() {
            continue;
        }

        // Hermes fetch for Pyth-feed quotes. Best-effort — a failure
        // here drops only the cross-source-quoted triggers this tick;
        // pure-Jupiter triggers still evaluate.
        let hermes_prices: HashMap<Pubkey, LatestPrice> = if hermes_quote_pubkeys.is_empty() {
            HashMap::new()
        } else {
            let feed_hex: Vec<String> =
                hermes_quote_pubkeys.iter().map(pubkey_to_hex).collect();
            match fetch_pyth_prices(&http, &cfg.hermes_url, &feed_hex).await {
                Ok(by_hex) => {
                    let mut out = HashMap::with_capacity(by_hex.len());
                    for (i, hex) in feed_hex.iter().enumerate() {
                        if let Some(p) = by_hex.get(&hex.to_lowercase()) {
                            out.insert(hermes_quote_pubkeys[i], p.clone());
                        }
                    }
                    out
                }
                Err(e) => {
                    warn!(error = %e, "jupiter_watcher: hermes quote fetch failed");
                    HashMap::new()
                }
            }
        };

        let now_unix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        // Map: correlation_key → (matches, snapshot_for_this_mint).
        let mut to_fire: HashMap<String, (Vec<AutomationCtx>, PriceSnapshot)> = HashMap::new();
        let mut already: HashSet<Pubkey> = HashSet::new();

        for mint in &base_mints {
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
                let crossed = match quote_mint {
                    None => match *comparator {
                        0 => crossed_below(&latest, *threshold, *expo),
                        1 => crossed_above(&latest, *threshold, *expo),
                        _ => false,
                    },
                    Some(qm) => {
                        // Pair-quoted: ratio = base / quote. The quote
                        // price comes from whichever source the catalog
                        // dispatched to (Pyth feed id → Hermes, SPL
                        // mint → Jupiter). Skip if the quote price
                        // wasn't returned (will retry next tick).
                        let (q_raw, q_expo) = if let Some(p) = hermes_prices.get(qm) {
                            (p.raw as i128, p.expo)
                        } else if let Some(p) = prices.get(qm) {
                            (*p as i128, JUPITER_PRICE_EXPO)
                        } else {
                            continue;
                        };
                        ratio_compare(
                            *comparator,
                            (latest.raw as i128, latest.expo),
                            (q_raw, q_expo),
                            *threshold,
                            *expo,
                        )
                        .unwrap_or(false)
                    }
                };
                if crossed {
                    let key = format!("jupiter:{}:{now_unix}", mint);
                    // Jupiter REST doesn't carry a conf value; publish_time
                    // approximated with now_unix. SourceLayer::HermesPoll is
                    // the closest analogue for a REST poll path.
                    // raw_price + expo are None: Jupiter returns f64 prices
                    // only and has no Pyth integer-wire format, so there is
                    // no integer mantissa to preserve here. Pyth-quoted ratio
                    // triggers via the cache-driven evaluator require both legs
                    // to be Pyth-sourced; Jupiter-based snapshots cannot
                    // participate in that path.
                    let snap = PriceSnapshot {
                        price: *price as f64 * 10f64.powi(JUPITER_PRICE_EXPO),
                        conf: 0.0,
                        publish_time: now_unix,
                        fetched_at: std::time::Instant::now(),
                        source: SourceLayer::HermesPoll,
                        raw_price: None,
                        expo: None,
                    };
                    let entry = to_fire.entry(key).or_insert_with(|| (Vec::new(), snap));
                    entry.0.push(ctx.clone());
                }
            }
        }

        for (correlation, (matches, snap)) in to_fire {
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
                snapshot: Some(snap),
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
        // Scale USD float → i64 fixed-point. Defense in depth: usd was
        // already constrained to `>0 && finite` above, but the
        // multiplication can produce ±inf if usd is near f64::MAX (it
        // can't here, but it's free to check) and `.round() as i64`
        // saturates rather than wrapping — guard the boundary so we
        // never insert a saturated/clipped value that would silently
        // mis-trigger a price condition. `>=` (not `>`) because
        // `i64::MAX as f64` rounds up to one past i64::MAX.
        let scaled = usd * JUPITER_PRICE_SCALE;
        if !scaled.is_finite() || scaled < 0.0 || scaled >= i64::MAX as f64 {
            continue;
        }
        out.insert(mint, scaled.round() as i64);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jup_raw(usd: f64) -> i64 {
        (usd * JUPITER_PRICE_SCALE).round() as i64
    }

    /// Pair-quoted Jupiter trigger: ratio = base/quote in USD terms.
    /// Both legs come from `/price/v3` at expo=-6, so `ratio_compare`
    /// just cross-multiplies the raw integers.
    #[test]
    fn jupiter_ratio_above_threshold_crosses() {
        let base = jup_raw(150.0);
        let quote = jup_raw(100.0);
        // 150 / 100 = 1.5 vs threshold 1.4 (raw=1_400_000, expo=-6)
        let crossed = ratio_compare(
            1,
            (base as i128, JUPITER_PRICE_EXPO),
            (quote as i128, JUPITER_PRICE_EXPO),
            1_400_000,
            -6,
        )
        .unwrap();
        assert!(crossed, "1.5 should cross above 1.4");
    }

    #[test]
    fn jupiter_ratio_below_threshold_does_not_cross() {
        let base = jup_raw(150.0);
        let quote = jup_raw(100.0);
        // 150 / 100 = 1.5 vs threshold 1.6 — not crossed above
        let crossed = ratio_compare(
            1,
            (base as i128, JUPITER_PRICE_EXPO),
            (quote as i128, JUPITER_PRICE_EXPO),
            1_600_000,
            -6,
        )
        .unwrap();
        assert!(!crossed, "1.5 should not cross above 1.6");
    }

    #[test]
    fn jupiter_ratio_below_comparator_crosses() {
        let base = jup_raw(0.85);
        let quote = jup_raw(1.0);
        // 0.85 / 1.0 = 0.85 vs threshold 0.9 — crosses below
        let crossed = ratio_compare(
            0,
            (base as i128, JUPITER_PRICE_EXPO),
            (quote as i128, JUPITER_PRICE_EXPO),
            900_000,
            -6,
        )
        .unwrap();
        assert!(crossed, "0.85 should cross below 0.9");
    }
}
