use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Notify, RwLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SourceLayer {
    Lazer = 1,
    HermesSse = 2,
    AdaptivePoll = 3,
    HermesPoll = 4,
}

impl SourceLayer {
    pub fn max_age(self) -> Duration {
        match self {
            Self::Lazer => Duration::from_millis(1000),
            Self::HermesSse => Duration::from_millis(2000),
            Self::AdaptivePoll => Duration::from_millis(5000),
            Self::HermesPoll => Duration::from_millis(15000),
        }
    }
}

#[derive(Clone, Debug)]
pub struct PriceSnapshot {
    pub price: f64,
    pub conf: f64,
    pub publish_time: i64,
    pub fetched_at: Instant,
    pub source: SourceLayer,
}

#[derive(Clone, Default)]
pub struct PriceCache {
    inner: Arc<RwLock<HashMap<String, PriceSnapshot>>>,
    notify: Arc<Notify>,
}

impl PriceCache {
    pub fn new() -> Self { Self::default() }

    pub async fn put(&self, feed_id: String, snap: PriceSnapshot) {
        let mut g = self.inner.write().await;
        // Don't overwrite a fresher snapshot from a higher-priority layer with stale data
        // from a lower-priority layer.
        if let Some(existing) = g.get(&feed_id) {
            if (existing.source as u8) < (snap.source as u8)
                && existing.fetched_at.elapsed() < existing.source.max_age()
            {
                return;
            }
        }
        g.insert(feed_id, snap);
        // Drop the write lock before notifying so waiters can immediately acquire a read lock.
        drop(g);
        self.notify.notify_waiters();
    }

    pub async fn get_fresh(&self, feed_id: &str) -> Option<PriceSnapshot> {
        let g = self.inner.read().await;
        let snap = g.get(feed_id)?.clone();
        if snap.fetched_at.elapsed() <= snap.source.max_age() { Some(snap) } else { None }
    }

    /// Returns a handle that wakes every `notify.notified()` caller whenever
    /// a new snapshot is written via `put`. Price-watcher uses this to drive
    /// its evaluation loop.
    pub fn notifier(&self) -> Arc<Notify> { self.notify.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fresh_lazer_beats_stale_hermes() {
        let c = PriceCache::new();
        c.put("BTC".into(), PriceSnapshot {
            price: 100.0, conf: 1.0, publish_time: 0,
            fetched_at: Instant::now(), source: SourceLayer::Lazer,
        }).await;
        // Try to overwrite with HermesPoll — should be rejected.
        c.put("BTC".into(), PriceSnapshot {
            price: 999.0, conf: 1.0, publish_time: 0,
            fetched_at: Instant::now(), source: SourceLayer::HermesPoll,
        }).await;
        let got = c.get_fresh("BTC").await.unwrap();
        assert_eq!(got.price, 100.0);
    }

    #[tokio::test]
    async fn stale_snapshot_returns_none() {
        let c = PriceCache::new();
        let too_old = Instant::now() - Duration::from_secs(10);
        c.put("ETH".into(), PriceSnapshot {
            price: 5.0, conf: 0.1, publish_time: 0,
            fetched_at: too_old, source: SourceLayer::Lazer,
        }).await;
        assert!(c.get_fresh("ETH").await.is_none());
    }
}
