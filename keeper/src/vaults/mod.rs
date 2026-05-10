use crate::streaming::{AccountUpdate, StreamSource};
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tracing::{info, warn};

#[derive(Clone, Default)]
pub struct VaultCache {
    inner: Arc<RwLock<HashMap<Pubkey, AccountUpdate>>>,
}

impl VaultCache {
    pub fn new() -> Self { Self::default() }
    pub async fn get(&self, account: &Pubkey) -> Option<AccountUpdate> {
        self.inner.read().await.get(account).cloned()
    }
    pub async fn put(&self, account: Pubkey, update: AccountUpdate) {
        self.inner.write().await.insert(account, update);
    }
}

pub struct VaultManager {
    source: Arc<dyn StreamSource>,
    handles: RwLock<HashMap<Pubkey, JoinHandle<()>>>,
    cache: VaultCache,
}

impl VaultManager {
    pub fn new(source: Arc<dyn StreamSource>, cache: VaultCache) -> Self {
        Self { source, handles: RwLock::new(HashMap::new()), cache }
    }

    pub async fn subscribe(&self, account: Pubkey) {
        let mut g = self.handles.write().await;
        if g.contains_key(&account) { return }
        let cache = self.cache.clone();
        let source = self.source.clone();
        let h = tokio::spawn(async move {
            let mut rx = match source.subscribe_account(account).await {
                Ok(rx) => rx,
                Err(e) => { warn!(target: "vaults", %account, error = %e, "subscribe failed"); return }
            };
            info!(target: "vaults", %account, "subscribed");
            while let Some(update) = rx.recv().await {
                cache.put(account, update).await;
            }
        });
        g.insert(account, h);
    }

    pub async fn unsubscribe(&self, account: &Pubkey) {
        if let Some(h) = self.handles.write().await.remove(account) { h.abort(); }
    }

    pub async fn reconcile(&self, desired: &[Pubkey]) {
        let desired: std::collections::HashSet<Pubkey> = desired.iter().copied().collect();
        let current: Vec<Pubkey> = self.handles.read().await.keys().copied().collect();
        for a in &current {
            if !desired.contains(a) { self.unsubscribe(a).await; }
        }
        for a in &desired {
            if !self.handles.read().await.contains_key(a) { self.subscribe(*a).await; }
        }
    }
}
