use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
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

/// In-memory cache of fill records keyed by upstream automation pubkey.
///
/// NOTE: FillCache is NOT persisted to disk. If the keeper restarts, all
/// fill records are lost and downstream PriceRelativeToFill triggers will
/// not fire until the upstream automation executes again and emits a fresh
/// AutomationFilled event. This is acceptable for the MVP: users can
/// recreate chains if needed, and the 24h TTL bounds the max stale window.
#[derive(Clone, Default)]
pub struct FillCache {
    inner: Arc<RwLock<HashMap<Pubkey, Fill>>>,
}

impl FillCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert or replace the fill record for the given upstream pubkey.
    pub async fn put(&self, fill: Fill) {
        self.inner.write().await.insert(fill.upstream, fill);
    }

    /// Return the fill record for `upstream` if it exists and is within
    /// `Fill::max_age()`. Returns `None` if the record is missing or stale.
    pub async fn get_fresh(&self, upstream: &Pubkey) -> Option<Fill> {
        let g = self.inner.read().await;
        let f = g.get(upstream)?.clone();
        if f.observed_at.elapsed() <= Fill::max_age() {
            Some(f)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
