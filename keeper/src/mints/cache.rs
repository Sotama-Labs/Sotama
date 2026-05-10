use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Notify, RwLock};

#[derive(Clone, Debug)]
pub struct MintPriceSnapshot {
    pub mint: Pubkey,
    /// USD price as reported by Jupiter Price API v3.
    pub price_usd: f64,
    pub fetched_at: Instant,
}

impl MintPriceSnapshot {
    /// Max acceptable age for a Jupiter-derived snapshot before the evaluator
    /// drops fires. Jupiter probes at 1s base; allow up to 5s to absorb backoff.
    pub fn max_age() -> Duration {
        Duration::from_secs(5)
    }
}

#[derive(Clone, Default)]
pub struct MintPriceCache {
    inner: Arc<RwLock<HashMap<Pubkey, MintPriceSnapshot>>>,
    notify: Arc<Notify>,
}

impl MintPriceCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn put(&self, mint: Pubkey, price_usd: f64) {
        let snap = MintPriceSnapshot {
            mint,
            price_usd,
            fetched_at: Instant::now(),
        };
        self.inner.write().await.insert(mint, snap);
        self.notify.notify_waiters();
    }

    pub async fn get_fresh(&self, mint: &Pubkey) -> Option<MintPriceSnapshot> {
        let g = self.inner.read().await;
        let s = g.get(mint)?.clone();
        if s.fetched_at.elapsed() <= MintPriceSnapshot::max_age() {
            Some(s)
        } else {
            None
        }
    }

    pub async fn snapshot_all(&self) -> HashMap<Pubkey, MintPriceSnapshot> {
        self.inner.read().await.clone()
    }

    pub fn notifier(&self) -> Arc<Notify> {
        self.notify.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fresh_after_put() {
        let c = MintPriceCache::new();
        let mint = Pubkey::new_unique();
        c.put(mint, 12.34).await;
        assert!(
            (c.get_fresh(&mint).await.unwrap().price_usd - 12.34).abs() < 1e-9,
            "price should match what was inserted"
        );
    }

    #[tokio::test]
    async fn missing_returns_none() {
        let c = MintPriceCache::new();
        assert!(c.get_fresh(&Pubkey::new_unique()).await.is_none());
    }
}
