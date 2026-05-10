use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::hash::Hash;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tracing::{debug, warn};

#[derive(Clone)]
pub struct BlockhashCache {
    inner: Arc<RwLock<Option<CachedBlockhash>>>,
}

#[derive(Clone, Debug)]
pub struct CachedBlockhash {
    pub hash: Hash,
    pub last_valid_block_height: u64,
    pub fetched_at: std::time::Instant,
}

impl BlockhashCache {
    pub fn new() -> Self {
        Self { inner: Arc::new(RwLock::new(None)) }
    }
    pub async fn read(&self) -> Option<CachedBlockhash> {
        self.inner.read().await.clone()
    }
    pub async fn write(&self, value: CachedBlockhash) {
        *self.inner.write().await = Some(value);
    }
}

impl Default for BlockhashCache {
    fn default() -> Self { Self::new() }
}

pub fn spawn_refresher(rpc: Arc<RpcClient>, cache: BlockhashCache) {
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(1));
        iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            iv.tick().await;
            match rpc.get_latest_blockhash_with_commitment(solana_sdk::commitment_config::CommitmentConfig::confirmed()).await {
                Ok((hash, last_valid_block_height)) => {
                    cache.write(CachedBlockhash {
                        hash,
                        last_valid_block_height,
                        fetched_at: std::time::Instant::now(),
                    }).await;
                    debug!(target: "caches::blockhash", %hash, last_valid_block_height, "refreshed");
                }
                Err(e) => warn!(target: "caches::blockhash", error = %e, "refresh failed"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn read_returns_none_when_unset() {
        let c = BlockhashCache::new();
        assert!(c.read().await.is_none());
    }

    #[tokio::test]
    async fn write_then_read_round_trips() {
        let c = BlockhashCache::new();
        let v = CachedBlockhash {
            hash: Hash::new_unique(),
            last_valid_block_height: 1234,
            fetched_at: std::time::Instant::now(),
        };
        c.write(v.clone()).await;
        let got = c.read().await.expect("must be set");
        assert_eq!(got.hash, v.hash);
        assert_eq!(got.last_valid_block_height, v.last_valid_block_height);
    }
}
