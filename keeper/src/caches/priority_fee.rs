use reqwest::Client;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, warn};

#[derive(Clone, Debug)]
pub struct CachedFee {
    pub microlamports_per_cu: u64,
    pub fetched_at: std::time::Instant,
}

#[derive(Clone)]
pub struct PriorityFeeCache {
    inner: Arc<RwLock<Option<CachedFee>>>,
}

impl PriorityFeeCache {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(None)) }
    }

    pub async fn read(&self) -> Option<CachedFee> {
        self.inner.read().await.clone()
    }

    pub async fn write(&self, v: CachedFee) {
        *self.inner.write().await = Some(v);
    }

    /// Returns the buffered fee (1.2× the cached value), or `default_floor` if the cache is empty.
    pub async fn buffered(&self, default_floor: u64) -> u64 {
        match self.read().await {
            Some(c) => ((c.microlamports_per_cu as u128 * 12) / 10) as u64,
            None => default_floor,
        }
    }

    /// Returns the buffered fee clamped to `[floor, ceiling]`. Both bounds
    /// are inclusive. Use this in the executor's hot path so:
    ///   * a stale `priority_fee_cache` (or one that returned 0) never
    ///     ships a tx below the configured floor — the validator would
    ///     accept it but the leader queue de-prioritizes it and we lose
    ///     the landing race during congestion;
    ///   * a runaway `getPriorityFeeEstimate` spike (Helius briefly
    ///     returning multi-SOL/CU under abusive on-chain conditions)
    ///     can't drain the keeper's operating SOL via a single tx.
    /// Caller-supplied bounds come from `KeeperConfig`'s
    /// `priority_fee_floor` / `priority_fee_ceiling` env knobs.
    pub async fn buffered_clamped(&self, floor: u64, ceiling: u64) -> u64 {
        let buffered = self.buffered(floor).await;
        buffered.max(floor).min(ceiling)
    }
}

impl Default for PriorityFeeCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Refreshes via Helius RPC `getPriorityFeeEstimate` with `priorityLevel: "High"` (p75 in Helius's
/// Min/Low/Medium/High/VeryHigh/UnsafeMax mapping). Helius now rejects lowercase variants.
pub fn spawn_refresher(
    http: Client,
    rpc_url: String,
    representative_accounts: Vec<String>,
    cache: PriorityFeeCache,
) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(5));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            iv.tick().await;
            let body = json!({
                "jsonrpc": "2.0",
                "id": "priority-fee-cache",
                "method": "getPriorityFeeEstimate",
                "params": [{
                    "accountKeys": representative_accounts,
                    "options": { "priorityLevel": "High" },
                }],
            });
            match http.post(&rpc_url).json(&body).send().await {
                Ok(resp) => match resp.json::<serde_json::Value>().await {
                    Ok(v) => {
                        let fee = v
                            .get("result")
                            .and_then(|r| r.get("priorityFeeEstimate"))
                            .and_then(|f| f.as_f64())
                            .map(|f| f as u64);
                        if let Some(microlamports_per_cu) = fee {
                            cache
                                .write(CachedFee {
                                    microlamports_per_cu,
                                    fetched_at: std::time::Instant::now(),
                                })
                                .await;
                            debug!(target: "caches::priority_fee", microlamports_per_cu, "refreshed");
                        } else {
                            warn!(target: "caches::priority_fee", payload = %v, "no priorityFeeEstimate in response");
                        }
                    }
                    Err(e) => warn!(target: "caches::priority_fee", error = %e, "json parse failed"),
                },
                Err(e) => warn!(target: "caches::priority_fee", error = %e, "request failed"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn buffered_applies_20_percent_premium() {
        let c = PriorityFeeCache::new();
        c.write(CachedFee { microlamports_per_cu: 100_000, fetched_at: std::time::Instant::now() })
            .await;
        assert_eq!(c.buffered(1).await, 120_000);
    }

    #[tokio::test]
    async fn buffered_returns_floor_when_empty() {
        let c = PriorityFeeCache::new();
        assert_eq!(c.buffered(50_000).await, 50_000);
    }

    #[tokio::test]
    async fn buffered_clamped_caps_runaway_spikes() {
        let c = PriorityFeeCache::new();
        // Helius briefly returns 5 SOL/CU under abusive on-chain conditions
        // (5_000_000_000 micros/CU). The ceiling clamps to the configured
        // max so the keeper doesn't burn a tx fee on a single landing.
        c.write(CachedFee {
            microlamports_per_cu: 5_000_000_000,
            fetched_at: std::time::Instant::now(),
        })
        .await;
        assert_eq!(c.buffered_clamped(50_000, 1_000_000).await, 1_000_000);
    }

    #[tokio::test]
    async fn buffered_clamped_lifts_below_floor() {
        let c = PriorityFeeCache::new();
        // Cache reads a near-zero fee (very calm chain); the floor keeps
        // the keeper in the SWQoS-preferred lane so we still land
        // quickly on burst arrivals.
        c.write(CachedFee {
            microlamports_per_cu: 100,
            fetched_at: std::time::Instant::now(),
        })
        .await;
        assert_eq!(c.buffered_clamped(50_000, 1_000_000).await, 50_000);
    }
}
