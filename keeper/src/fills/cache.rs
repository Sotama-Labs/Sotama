use serde::{Deserialize, Serialize};
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

/// A single fill record computed from an `AutomationFilled` event.
/// Keyed by the upstream automation pubkey in `FillCache`.
#[derive(Clone, Debug)]
pub struct Fill {
    /// The upstream automation pubkey that generated this fill.
    pub upstream: Pubkey,
    /// Effective USD price per output-mint unit at fill time.
    /// Computed as: (input_amount * input_mint_USD_price) / output_amount
    /// where both amounts are decimal-adjusted to real units.
    pub effective_usd_per_output: f64,
    /// Slot at which the fill occurred (from on-chain event).
    pub fill_slot: u64,
    /// Wall-clock instant the keeper observed this fill (for staleness).
    pub observed_at: Instant,
}

impl Fill {
    /// Maximum useful age of a fill record. After 24h the cost basis is
    /// almost certainly out of date; the keeper drops the record and the
    /// downstream PriceRelativeToFill trigger stops firing until a new
    /// fill arrives.
    pub fn max_age() -> Duration {
        Duration::from_secs(24 * 60 * 60)
    }
}

// ---------------------------------------------------------------------------
// Serialization shim — Instant is not serializable; persist as unix-ms u64.
// ---------------------------------------------------------------------------

/// On-disk representation of a single fill record.
#[derive(Serialize, Deserialize)]
struct FillRecord {
    /// Base-58 encoded upstream automation pubkey.
    upstream_b58: String,
    effective_usd_per_output: f64,
    fill_slot: u64,
    /// Unix timestamp in milliseconds when the fill was observed.
    observed_at_unix_ms: u64,
}

impl FillRecord {
    fn from_fill(fill: &Fill) -> Self {
        let observed_at_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| {
                // Subtract elapsed since observed_at to recover the original
                // wall-clock moment when the fill was recorded.
                let elapsed = fill.observed_at.elapsed();
                d.saturating_sub(elapsed).as_millis() as u64
            })
            .unwrap_or(0);

        Self {
            upstream_b58: fill.upstream.to_string(),
            effective_usd_per_output: fill.effective_usd_per_output,
            fill_slot: fill.fill_slot,
            observed_at_unix_ms,
        }
    }

    /// Convert back to a `Fill`, reconstructing `observed_at` as an `Instant`
    /// relative to now. Returns `None` if the pubkey is invalid, the timestamp
    /// is in the future (clock skew), or the entry is older than `max_age`.
    fn to_fill(&self) -> Option<Fill> {
        let upstream = self.upstream_b58.parse::<Pubkey>().ok()?;

        let now_unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis() as u64;

        // Reject entries with a future timestamp (clock skew guard).
        if self.observed_at_unix_ms > now_unix_ms {
            return None;
        }

        let age_ms = now_unix_ms - self.observed_at_unix_ms;
        let age = Duration::from_millis(age_ms);

        // Drop entries older than max_age.
        if age > Fill::max_age() {
            return None;
        }

        // Reconstruct observed_at as an Instant by subtracting age from now.
        let observed_at = Instant::now().checked_sub(age)?;

        Some(Fill {
            upstream,
            effective_usd_per_output: self.effective_usd_per_output,
            fill_slot: self.fill_slot,
            observed_at,
        })
    }
}

// ---------------------------------------------------------------------------
// FillCache
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Inner {
    map: HashMap<Pubkey, Fill>,
    path: Option<PathBuf>,
}

/// Thread-safe cache of fill records keyed by upstream automation pubkey.
///
/// When constructed via `FillCache::with_persistence`, fills are atomically
/// flushed to disk on every `put`. On restart the cache is rehydrated from
/// the persisted file, so `PriceRelativeToFill` triggers survive keeper
/// redeploys and host migrations.
///
/// Use `FillCache::new()` for the in-memory-only mode (tests, devnet).
#[derive(Clone, Default)]
pub struct FillCache {
    inner: Arc<RwLock<Inner>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            map: HashMap::new(),
            path: None,
        }
    }
}

impl FillCache {
    /// In-memory-only constructor. No disk I/O; safe for tests and existing
    /// callers that don't need persistence.
    pub fn new() -> Self {
        Self::default()
    }

    /// Persistent constructor. Loads existing fills from `path` (logs warn and
    /// starts fresh on read/parse error). Every subsequent `put` atomically
    /// writes the full map to disk via a temp-file + rename.
    pub fn with_persistence(path: PathBuf) -> anyhow::Result<Self> {
        let map = load_from_disk(&path);
        Ok(Self {
            inner: Arc::new(RwLock::new(Inner {
                map,
                path: Some(path),
            })),
        })
    }

    /// Insert or replace the fill record for the given upstream pubkey.
    pub async fn put(&self, fill: Fill) {
        let mut g = self.inner.write().await;
        g.map.insert(fill.upstream, fill);

        // Persist if a path is configured. Errors are non-fatal — the
        // in-memory state is already updated.
        if let Some(ref path) = g.path.clone() {
            if let Err(e) = flush_to_disk(&g.map, path) {
                tracing::warn!(
                    target: "fills::cache",
                    error = %e,
                    path = %path.display(),
                    "fill cache flush failed; state updated in-memory only"
                );
            }
        }
    }

    /// Return the fill record for `upstream` if it exists and is within
    /// `Fill::max_age()`. Returns `None` if the record is missing or stale.
    pub async fn get_fresh(&self, upstream: &Pubkey) -> Option<Fill> {
        let g = self.inner.read().await;
        let f = g.map.get(upstream)?.clone();
        if f.observed_at.elapsed() <= Fill::max_age() {
            Some(f)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Disk helpers
// ---------------------------------------------------------------------------

/// Load fills from `path`. Returns an empty map on any error (missing file,
/// corrupt JSON, etc.) after logging a warning.
fn load_from_disk(path: &PathBuf) -> HashMap<Pubkey, Fill> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // First run — no file yet; start fresh silently.
            return HashMap::new();
        }
        Err(e) => {
            tracing::warn!(
                target: "fills::cache",
                error = %e,
                path = %path.display(),
                "fill cache: could not read persistence file; starting fresh"
            );
            return HashMap::new();
        }
    };

    let records: Vec<FillRecord> = match serde_json::from_slice(&bytes) {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(
                target: "fills::cache",
                error = %e,
                path = %path.display(),
                "fill cache: corrupt JSON in persistence file; starting fresh"
            );
            return HashMap::new();
        }
    };

    let mut map = HashMap::new();
    for rec in records {
        if let Some(fill) = rec.to_fill() {
            map.insert(fill.upstream, fill);
        }
    }
    tracing::info!(
        target: "fills::cache",
        count = map.len(),
        path = %path.display(),
        "fill cache: loaded from disk"
    );
    map
}

/// Serialize the current map (minus expired entries) to a temp file, then
/// atomically rename it into place. Returns an error if the write or rename
/// fails — the caller should log and continue.
fn flush_to_disk(map: &HashMap<Pubkey, Fill>, path: &PathBuf) -> anyhow::Result<()> {
    let records: Vec<FillRecord> = map
        .values()
        .filter(|f| f.observed_at.elapsed() <= Fill::max_age())
        .map(FillRecord::from_fill)
        .collect();

    let json = serde_json::to_vec(&records)?;

    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, &json)?;
    std::fs::rename(&tmp_path, path)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // -----------------------------------------------------------------------
    // Existing tests (unchanged behaviour)
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn put_get_round_trip() {
        let c = FillCache::new();
        let upstream = Pubkey::new_unique();
        c.put(Fill {
            upstream,
            effective_usd_per_output: 80_000.0,
            fill_slot: 12345,
            observed_at: Instant::now(),
        })
        .await;
        let got = c.get_fresh(&upstream).await.unwrap();
        assert!(
            (got.effective_usd_per_output - 80_000.0).abs() < 1e-9,
            "price should round-trip exactly"
        );
        assert_eq!(got.fill_slot, 12345);
    }

    #[tokio::test]
    async fn missing_returns_none() {
        let c = FillCache::new();
        assert!(c.get_fresh(&Pubkey::new_unique()).await.is_none());
    }

    #[tokio::test]
    async fn overwrite_replaces_old_fill() {
        let c = FillCache::new();
        let upstream = Pubkey::new_unique();
        c.put(Fill {
            upstream,
            effective_usd_per_output: 100.0,
            fill_slot: 1,
            observed_at: Instant::now(),
        })
        .await;
        c.put(Fill {
            upstream,
            effective_usd_per_output: 200.0,
            fill_slot: 2,
            observed_at: Instant::now(),
        })
        .await;
        let got = c.get_fresh(&upstream).await.unwrap();
        assert!(
            (got.effective_usd_per_output - 200.0).abs() < 1e-9,
            "second put should replace the first"
        );
        assert_eq!(got.fill_slot, 2);
    }

    #[tokio::test]
    async fn expired_fill_returns_none() {
        let c = FillCache::new();
        let upstream = Pubkey::new_unique();
        // Simulate a fill that was observed 25 hours ago (past max_age).
        let expired_at = Instant::now() - Duration::from_secs(25 * 60 * 60);
        c.put(Fill {
            upstream,
            effective_usd_per_output: 50.0,
            fill_slot: 99,
            observed_at: expired_at,
        })
        .await;
        // get_fresh should return None since the fill is older than 24h.
        assert!(
            c.get_fresh(&upstream).await.is_none(),
            "fill older than 24h should be treated as stale"
        );
    }

    // -----------------------------------------------------------------------
    // New persistence tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn persists_and_reloads_across_handle() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fills.json");
        let upstream = Pubkey::new_unique();

        // Write a fill and drop the handle.
        {
            let cache = FillCache::with_persistence(path.clone()).unwrap();
            cache
                .put(Fill {
                    upstream,
                    effective_usd_per_output: 42_000.0,
                    fill_slot: 9999,
                    observed_at: Instant::now(),
                })
                .await;
            // cache dropped here — Arc refcount falls to zero.
        }

        // Reload from the same path and verify the fill is present.
        let cache2 = FillCache::with_persistence(path.clone()).unwrap();
        let got = cache2.get_fresh(&upstream).await.expect("fill should survive reload");
        assert!(
            (got.effective_usd_per_output - 42_000.0).abs() < 1e-9,
            "price should survive reload"
        );
        assert_eq!(got.fill_slot, 9999);
    }

    #[tokio::test]
    async fn expired_entries_are_pruned_on_load() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fills_stale.json");
        let upstream = Pubkey::new_unique();

        // Write a stale record directly to disk (observed_at_unix_ms = 0,
        // i.e. Unix epoch — clearly older than 24h).
        let stale_record = FillRecord {
            upstream_b58: upstream.to_string(),
            effective_usd_per_output: 1.0,
            fill_slot: 1,
            observed_at_unix_ms: 0,
        };
        let json = serde_json::to_vec(&vec![stale_record]).unwrap();
        std::fs::write(&path, &json).unwrap();

        // Load; the stale entry should be pruned.
        let cache = FillCache::with_persistence(path).unwrap();
        assert!(
            cache.get_fresh(&upstream).await.is_none(),
            "stale entry from disk should be discarded"
        );
    }

    #[tokio::test]
    async fn atomic_write_on_put() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("fills_atomic.json");
        let tmp_path = dir.path().join("fills_atomic.tmp");

        let cache = FillCache::with_persistence(path.clone()).unwrap();
        cache
            .put(Fill {
                upstream: Pubkey::new_unique(),
                effective_usd_per_output: 1.0,
                fill_slot: 1,
                observed_at: Instant::now(),
            })
            .await;

        // After a successful put the temp file must not exist (rename succeeded).
        assert!(
            !tmp_path.exists(),
            "temp file should be renamed away after atomic write"
        );
        // And the real file must exist.
        assert!(path.exists(), "persistence file should exist after put");
    }
}
