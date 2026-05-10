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
use crate::jupiter::JupiterClient;
use crate::prices::cache::{PriceSnapshot, SourceLayer};
use crate::pyth_catalog::{self, PythCatalog};
use crate::state::TriggerSpec;
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
) -> Result<()> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()?;
    let mut tick = interval(cfg.price_poll_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let jupiter = JupiterClient::new(http.clone(), cfg.jupiter_base_url.clone());

    // Pyth catalog for cross-source quote dispatch. Pyth-feed quote_mints
    // (Equity / FX / Metal / Commodity quotes that have no SPL mint) are
    // fetched from Hermes alongside the base feeds; SPL-mint quotes use
    // the existing Jupiter `/quote` probe. Best-effort load — failure
    // here just means we lose cross-source quotes this session, SPL-mint
    // quotes still work via the unchanged probe path.
    let catalog: PythCatalog = match pyth_catalog::fetch().await {
        Ok(c) => {
            info!(
                feeds = c.len(),
                "price_watcher: loaded Pyth catalog for cross-source quote dispatch",
            );
            c
        }
        Err(e) => {
            warn!(error = %e, "price_watcher: Pyth catalog load failed; cross-source quotes disabled");
            PythCatalog::new()
        }
    };

    loop {
        tick.tick().await;
        let set = set_rx.borrow().clone();
        let lazer_active: HashSet<Pubkey> = lazer_active_feeds_rx.borrow().clone();
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
        // mints stay on the Jupiter probe path.
        let mut hermes_quote_pubkeys: Vec<Pubkey> = Vec::new();
        let mut jupiter_quote_mints: Vec<Pubkey> = Vec::new();
        for qm in set.asset_price_quote_mints() {
            if catalog.contains_key(&qm.to_bytes()) {
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

        let prices = match fetch_prices(&http, &cfg.hermes_url, &feed_hex).await {
            Ok(p) => p,
            Err(e) => {
                warn!(error = %e, "price_watcher: hermes fetch failed");
                continue;
            }
        };

        // Hermes-derived quote prices keyed by quote pubkey for fast
        // lookup in the comparator dispatch below.
        let mut hermes_quote_prices: HashMap<Pubkey, LatestPrice> = HashMap::new();
        for qm in &hermes_quote_pubkeys {
            let hex = pubkey_to_hex(qm).to_lowercase();
            if let Some(p) = prices.get(&hex) {
                hermes_quote_prices.insert(*qm, p.clone());
            }
        }

        // Per-tick cache of Jupiter `/quote` probes for SPL-mint quotes.
        // Cached so a mint shared across many triggers (USDC most likely)
        // isn't probed twice.
        let mut mint_quotes: HashMap<Pubkey, MintQuote> = HashMap::new();
        for mint in jupiter_quote_mints {
            match probe_mint(&jupiter, &mint, cfg.swap_slippage_bps).await {
                Ok(q) => {
                    mint_quotes.insert(mint, q);
                }
                Err(e) => {
                    warn!(mint = %mint, error = %e, "price_watcher: quote-mint /quote failed");
                }
            }
        }

        // Map: correlation_key → (matches, snapshot_for_this_feed).
        let mut to_fire: HashMap<String, (Vec<AutomationCtx>, PriceSnapshot)> = HashMap::new();
        let mut already: HashSet<Pubkey> = HashSet::new();

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
/// non-USD quote mint. Public so `revalidate.rs` can reuse the probe.
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
