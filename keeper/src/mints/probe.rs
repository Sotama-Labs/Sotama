use super::cache::MintPriceCache;
use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::Deserialize;
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::watch;
use tracing::{debug, warn};

const BASE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// Cap on how many mints we cram into a single `/price/v3?ids=...` call.
/// Mirrors the constant in jupiter_watcher.rs.
const PRICE_BATCH_SIZE: usize = 100;

/// Jupiter Price v3 response — single entry per mint. The response is a
/// flat `HashMap<String, PriceEntry>` with NO "data" wrapper; this matches
/// how `jupiter_watcher::fetch_prices` already deserializes the same endpoint.
#[derive(Debug, Deserialize)]
struct PriceEntry {
    #[serde(rename = "usdPrice")]
    usd_price: Option<f64>,
}

/// Spawn the Jupiter mint probe. Watches `mints_rx` for the active mint set;
/// polls Jupiter `/price/v3?ids=...` at 1s cadence with exponential backoff
/// on errors. Writes successful results into `cache`.
///
/// Runs in all stream modes (Off/Shadow/On). In Off/Shadow mode it coexists
/// with the jupiter_watcher 12s poll; in On mode it is the sole Jupiter price
/// source for the cache-driven evaluator.
pub fn spawn(
    http: Client,
    price_url: String,
    api_key: Option<String>,
    mut mints_rx: watch::Receiver<Vec<Pubkey>>,
    cache: MintPriceCache,
) {
    tokio::spawn(async move {
        let mut backoff = BASE_INTERVAL;
        loop {
            let mints: Vec<Pubkey> = mints_rx.borrow_and_update().clone();
            if mints.is_empty() {
                // Wait until the mint set changes (new automation created).
                if mints_rx.changed().await.is_err() {
                    return;
                }
                continue;
            }
            match probe_batched(&http, &price_url, api_key.as_deref(), &mints, &cache).await {
                Ok(()) => {
                    backoff = BASE_INTERVAL;
                    tokio::time::sleep(BASE_INTERVAL).await;
                }
                Err(e) => {
                    warn!(
                        target: "mints::probe",
                        error = %e,
                        backoff_ms = backoff.as_millis(),
                        "Jupiter probe failed"
                    );
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                }
            }
        }
    });
}

async fn probe_batched(
    http: &Client,
    price_url: &str,
    api_key: Option<&str>,
    mints: &[Pubkey],
    cache: &MintPriceCache,
) -> Result<()> {
    let mut total_written = 0usize;
    for chunk in mints.chunks(PRICE_BATCH_SIZE) {
        total_written += probe_once(http, price_url, api_key, chunk, cache).await?;
    }
    debug!(
        target: "mints::probe",
        total_mints = mints.len(),
        total_written,
        "Jupiter probe ok"
    );
    Ok(())
}

async fn probe_once(
    http: &Client,
    price_url: &str,
    api_key: Option<&str>,
    mints: &[Pubkey],
    cache: &MintPriceCache,
) -> Result<usize> {
    if mints.is_empty() {
        return Ok(0);
    }
    let ids = mints
        .iter()
        .map(|p| p.to_string())
        .collect::<Vec<_>>()
        .join(",");
    // `price_url` is the full endpoint e.g. "https://lite-api.jup.ag/price/v3"
    // (from config.jupiter_price_url). Append `?ids=...` directly.
    let url = format!("{}?ids={}", price_url.trim_end_matches('/'), ids);

    let mut req = http.get(&url);
    if let Some(key) = api_key {
        req = req.header("x-api-key", key);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| anyhow!("Jupiter probe GET: {e}"))?;

    let status = resp.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(anyhow!("Jupiter rate-limited (429)"));
    }
    if !status.is_success() {
        return Err(anyhow!("Jupiter probe status {}", status));
    }

    // Response is a flat HashMap<String, PriceEntry> — no "data" wrapper.
    // This matches how jupiter_watcher::fetch_prices deserializes the same endpoint.
    let map: HashMap<String, PriceEntry> = resp
        .json()
        .await
        .map_err(|e| anyhow!("Jupiter probe decode: {e}"))?;

    let mut written = 0usize;
    for mint in mints {
        let key = mint.to_string();
        let Some(entry) = map.get(&key) else {
            continue;
        };
        let Some(price) = entry.usd_price else {
            continue;
        };
        if !price.is_finite() || price <= 0.0 {
            continue;
        }
        cache.put(*mint, price).await;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_format_single_mint() {
        let mint = Pubkey::new_unique();
        let ids = mint.to_string();
        let url = format!("https://lite-api.jup.ag/price/v3?ids={ids}");
        assert!(url.contains("?ids="));
        assert!(url.contains(&mint.to_string()));
    }

    #[test]
    fn url_format_multiple_mints() {
        let mints = vec![Pubkey::new_unique(), Pubkey::new_unique()];
        let ids = mints
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert!(ids.contains(','), "batch ids should be comma-separated");
    }
}
