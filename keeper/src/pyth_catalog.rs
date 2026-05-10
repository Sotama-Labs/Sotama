//! Cached map of 32-byte Pyth feed ids → Lazer/Hermes metadata.
//!
//! Used by `jupiter_watcher` and `price_watcher` to disambiguate the
//! AssetPrice trigger's `quote_mint` field at fire time: a 32-byte
//! value that may be EITHER an SPL mint (probe via Jupiter) OR a Pyth
//! feed id (fetch via Hermes). Catalog hit → Pyth path; miss → existing
//! Jupiter probe. Source: same `/v1/symbols` endpoint `lazer_watcher`
//! uses for its base-feed translation, so the dispatch is consistent
//! across all three watchers.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, warn};

const SYMBOLS_URL: &str = "https://history.pyth-lazer.dourolabs.app/v1/symbols";

const REFRESH_INTERVAL: Duration = Duration::from_secs(300); // 5 min

/// Per-feed metadata keyed by the 32-byte Hermes feed id (same bytes
/// the on-chain AssetPrice trigger stores in either `feed: Pubkey` or
/// `quote_mint: Option<Pubkey>` when the quote is a Pyth-listed asset
/// without a Solana SPL mint).
#[derive(Debug, Clone)]
#[allow(dead_code)] // fields preserved for an eventual lazer_watcher refactor
pub struct PythFeedMeta {
    pub lazer_id: u32,
    pub exponent: i32,
}

pub type PythCatalog = HashMap<[u8; 32], PythFeedMeta>;

// ---------------------------------------------------------------------------
// PythCatalogHandle — cheaply-clonable, async-readable handle.
// ---------------------------------------------------------------------------

/// A cheaply-clonable, async-readable handle to the Pyth catalog.
///
/// The inner `RwLock<PythCatalog>` can be atomically swapped by the background
/// refresher without blocking readers. Callers that need a point-in-time
/// snapshot (e.g. per poll tick) should call `.snapshot().await`; hot-path
/// point lookups can use `.get()` or `.contains_mint()`.
#[derive(Clone, Default)]
pub struct PythCatalogHandle {
    inner: Arc<RwLock<PythCatalog>>,
}

impl PythCatalogHandle {
    /// Wrap an initial catalog in a new handle.
    pub fn new(initial: PythCatalog) -> Self {
        Self {
            inner: Arc::new(RwLock::new(initial)),
        }
    }

    /// Returns `true` if the catalog contains a feed for this 32-byte mint/feed id.
    pub async fn contains_mint(&self, mint: &[u8; 32]) -> bool {
        self.inner.read().await.contains_key(mint)
    }

    /// Returns the feed metadata for this 32-byte mint/feed id, if present.
    pub async fn get(&self, mint: &[u8; 32]) -> Option<PythFeedMeta> {
        self.inner.read().await.get(mint).cloned()
    }

    /// Snapshot the full map. Callers that iterate the catalog (e.g. per poll
    /// tick) should call this once and reuse the returned `HashMap`.
    pub async fn snapshot(&self) -> PythCatalog {
        self.inner.read().await.clone()
    }

    /// Atomically replace the catalog with a fresh fetch result.
    pub async fn replace(&self, next: PythCatalog) {
        *self.inner.write().await = next;
    }
}

/// Spawn a background task that re-fetches the catalog every 5 minutes
/// and atomically swaps it into `handle`. On fetch error, logs a warning
/// and keeps the existing catalog — it is never cleared on failure.
pub fn spawn_refresher(handle: PythCatalogHandle) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(REFRESH_INTERVAL);
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // First tick fires immediately; skip it — main.rs already did the initial fetch.
        iv.tick().await;
        loop {
            iv.tick().await;
            match fetch().await {
                Ok(next) => {
                    let prev_count = handle.snapshot().await.len();
                    let next_count = next.len();
                    handle.replace(next).await;
                    debug!(
                        target: "pyth_catalog",
                        prev = prev_count,
                        next = next_count,
                        "catalog refreshed"
                    );
                }
                Err(e) => warn!(
                    target: "pyth_catalog",
                    error = %e,
                    "catalog refresh failed; keeping existing catalog"
                ),
            }
        }
    });
}

/// Fetch the canonical Pyth catalog. Best-effort: callers should treat
/// failure as an empty catalog (no Pyth-feed quote support, fall back
/// to Jupiter-mint dispatch only).
pub async fn fetch() -> Result<PythCatalog> {
    #[derive(Deserialize)]
    struct SymbolRow {
        pyth_lazer_id: u32,
        exponent: i32,
        #[serde(default)]
        hermes_id: Option<String>,
    }

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let rows: Vec<SymbolRow> = http
        .get(SYMBOLS_URL)
        .send()
        .await
        .context("symbols GET")?
        .error_for_status()?
        .json()
        .await
        .context("symbols decode")?;

    let mut out = HashMap::with_capacity(rows.len());
    for r in rows {
        let Some(hex_str) = r.hermes_id else { continue };
        let s = hex_str.strip_prefix("0x").unwrap_or(&hex_str);
        let bytes = match hex::decode(s) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let arr: [u8; 32] = match bytes.try_into() {
            Ok(a) => a,
            Err(_) => continue,
        };
        out.insert(
            arr,
            PythFeedMeta {
                lazer_id: r.pyth_lazer_id,
                exponent: r.exponent,
            },
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn empty_handle_lookup_returns_none() {
        let h = PythCatalogHandle::new(HashMap::new());
        assert!(!h.contains_mint(&[0u8; 32]).await);
        assert!(h.get(&[0u8; 32]).await.is_none());
        assert_eq!(h.snapshot().await.len(), 0);
    }

    #[tokio::test]
    async fn replace_atomically_swaps() {
        let h = PythCatalogHandle::new(HashMap::new());
        assert!(!h.contains_mint(&[1u8; 32]).await);

        let mut next: PythCatalog = HashMap::new();
        next.insert([1u8; 32], PythFeedMeta { lazer_id: 42, exponent: -8 });
        h.replace(next).await;

        assert!(h.contains_mint(&[1u8; 32]).await);
        let meta = h.get(&[1u8; 32]).await.expect("meta should be present");
        assert_eq!(meta.lazer_id, 42);
        assert_eq!(meta.exponent, -8);
        // An unrelated key must still be absent.
        assert!(!h.contains_mint(&[2u8; 32]).await);
    }
}
