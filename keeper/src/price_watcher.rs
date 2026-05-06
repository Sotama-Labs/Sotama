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
use crate::state::TriggerSpec;
use crate::types::{AutomationCtx, TriggerEvent};

/// Polls Pyth Hermes for the live price of every TokenPrice-trigger feed
/// and emits TriggerEvents when the threshold is crossed. Stateless
/// across runs — does not persist "already crossed" markers, so a price
/// hovering near the threshold could fire repeatedly. The on-chain
/// `executed: bool` guard prevents double-execution per automation, and
/// the executor's `recent_triggers` cache prevents duplicate ix sends
/// within a single keeper session.
pub async fn run(
    cfg: Arc<KeeperConfig>,
    set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
) -> Result<()> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()?;
    let mut tick = interval(cfg.price_poll_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tick.tick().await;
        let set = set_rx.borrow().clone();
        if set.price_triggers.is_empty() {
            continue;
        }
        let feeds: Vec<Pubkey> = set.price_feeds();
        // Pyth Hermes expects the 32-byte feed ID as hex (lowercase, no
        // 0x), but on-chain we stored it as a Pubkey's raw bytes (base58
        // when Display'd). Convert here for the HTTP query.
        let feed_hex: Vec<String> = feeds.iter().map(|p| pubkey_to_hex(p)).collect();
        debug!(
            feeds = feed_hex.len(),
            "price_watcher: polling Pyth Hermes"
        );

        let prices = match fetch_prices(&http, &cfg.hermes_url, &feed_hex).await {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "price_watcher: hermes fetch failed");
                continue;
            }
        };

        let mut to_fire: HashMap<String, Vec<AutomationCtx>> = HashMap::new();
        let mut already: HashSet<Pubkey> = HashSet::new();

        for (feed, ctxs) in &set.price_triggers {
            let feed_hex_id = pubkey_to_hex(feed);
            let Some(price) = prices.get(&feed_hex_id) else {
                continue;
            };
            let feed_str = feed_hex_id.clone();
            for ctx in ctxs {
                if !already.insert(ctx.pubkey) {
                    continue;
                }
                if let TriggerSpec::TokenPrice {
                    comparator,
                    threshold,
                    expo,
                    ..
                } = &ctx.trigger
                {
                    let crossed = match *comparator {
                        0 => crossed_below(price, *threshold, *expo),
                        1 => crossed_above(price, *threshold, *expo),
                        _ => false,
                    };
                    if crossed {
                        let key = format!("{}:{}", feed_str, price.publish_time);
                        to_fire.entry(key).or_default().push(ctx.clone());
                    }
                }
            }
        }

        for (correlation, matches) in to_fire {
            info!(
                count = matches.len(),
                correlation,
                "price_watcher: threshold crossed; firing"
            );
            let evt = TriggerEvent {
                source: "price_watcher",
                correlation,
                matches,
            };
            if let Err(e) = trigger_tx.send(evt).await {
                return Err(anyhow!("price_watcher: trigger channel closed: {e}"));
            }
        }
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

async fn fetch_prices(
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
