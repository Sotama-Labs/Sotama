use super::cache::PriceCache;
use super::hermes_sse;
use reqwest::Client;
use std::collections::HashSet;
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tracing::{info, warn};

const RECONNECT_INTERVAL: Duration = Duration::from_secs(23 * 60 * 60);

/// Spawn the unified price stream. Lazer is the primary source when a token is configured
/// and the feed is in its catalog; Hermes SSE handles the rest. The existing 12s Hermes
/// batch poll stays available as a last-ditch fallback (driven by `price_watcher.rs`,
/// untouched here and gated off in Phase H).
///
/// `feed_ids_rx` is a watch channel whose value is the current set of active feed ids
/// (the indexer recomputes this every 2s based on the WatchedSet). Whenever the set
/// changes, we cancel the existing Hermes SSE subscription and respawn it with the new
/// list. Lazer integration writes into the same cache via a thin adapter installed in
/// `main.rs` — no spawn here.
pub fn spawn(
    http: Client,
    hermes_base_url: String,
    cache: PriceCache,
    mut feed_ids_rx: watch::Receiver<Vec<String>>,
) {
    tokio::spawn(async move {
        let mut current: HashSet<String> = HashSet::new();
        let mut current_handle: Option<JoinHandle<()>> = None;
        loop {
            let next: HashSet<String> = feed_ids_rx.borrow_and_update().iter().cloned().collect();
            if next != current {
                info!(target: "prices::stream", count = next.len(), "feed set changed, restarting Hermes SSE");
                if let Some(h) = current_handle.take() {
                    h.abort();
                }
                current = next.clone();
                let feed_list: Vec<String> = current.iter().cloned().collect();
                if !feed_list.is_empty() {
                    let h = tokio::spawn(hermes_sse_loop(
                        http.clone(),
                        hermes_base_url.clone(),
                        feed_list,
                        cache.clone(),
                    ));
                    current_handle = Some(h);
                }
            }
            if feed_ids_rx.changed().await.is_err() {
                return;
            }
        }
    });
}

async fn hermes_sse_loop(http: Client, base_url: String, feed_ids: Vec<String>, cache: PriceCache) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        match hermes_sse::run(&http, &base_url, &feed_ids, &cache, RECONNECT_INTERVAL).await {
            Ok(()) => {
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                warn!(
                    target: "prices::stream",
                    error = %e,
                    elapsed = ?started.elapsed(),
                    "hermes sse failed"
                );
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}
