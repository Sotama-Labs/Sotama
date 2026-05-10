use crate::program::associated_token_address;
use crate::streaming::{AccountUpdate, StreamSource};
use crate::types::VaultTarget;
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::task::JoinHandle;
use tracing::{info, warn};

/// Cache of the latest accountSubscribe update for each ATA pubkey.
/// Keyed by the ATA address (not by automation PDA) so callers can do
/// a direct lookup from a known mint+owner pair:
///
/// ```ignore
/// let ata = associated_token_address(&owner, &mint);
/// let update = cache.get(&ata).await;
/// ```
#[derive(Clone, Default)]
pub struct VaultCache {
    inner: Arc<RwLock<HashMap<Pubkey, AccountUpdate>>>,
}

impl VaultCache {
    pub fn new() -> Self { Self::default() }

    /// Look up the latest update for an ATA pubkey.
    pub async fn get(&self, ata: &Pubkey) -> Option<AccountUpdate> {
        self.inner.read().await.get(ata).cloned()
    }

    /// Store an update for an ATA pubkey.
    pub async fn put(&self, ata: Pubkey, update: AccountUpdate) {
        self.inner.write().await.insert(ata, update);
    }
}

pub struct VaultManager {
    source: Arc<dyn StreamSource>,
    /// Keyed by ATA pubkey (the actual token account address being
    /// watched, not the automation PDA). Computed deterministically
    /// from VaultTarget via `associated_token_address`.
    handles: RwLock<HashMap<Pubkey, JoinHandle<()>>>,
    cache: VaultCache,
}

impl VaultManager {
    pub fn new(source: Arc<dyn StreamSource>, cache: VaultCache) -> Self {
        Self { source, handles: RwLock::new(HashMap::new()), cache }
    }

    /// Subscribe to the ATA for `target.mint` owned by `target.owner`.
    /// The ATA address is computed deterministically via
    /// `associated_token_address` — no RPC needed. If already
    /// subscribed (same ATA pubkey), returns without creating a
    /// duplicate handle.
    pub async fn subscribe(&self, target: VaultTarget) {
        let ata = associated_token_address(&target.owner, &target.mint);
        let mut g = self.handles.write().await;
        if g.contains_key(&ata) { return; }
        let cache = self.cache.clone();
        let source = self.source.clone();
        let h = tokio::spawn(async move {
            let mut rx = match source.subscribe_account(ata).await {
                Ok(rx) => rx,
                Err(e) => {
                    warn!(target: "vaults", %ata, error = %e, "subscribe failed");
                    return;
                }
            };
            info!(target: "vaults", %ata, "subscribed");
            while let Some(update) = rx.recv().await {
                cache.put(ata, update).await;
            }
        });
        g.insert(ata, h);
    }

    /// Abort the accountSubscribe handle for a given ATA pubkey.
    pub async fn unsubscribe(&self, ata: &Pubkey) {
        if let Some(h) = self.handles.write().await.remove(ata) { h.abort(); }
    }

    /// Reconcile active subscriptions against a desired set of
    /// `VaultTarget`s. Each target maps to an ATA pubkey; handles for
    /// ATAs no longer in `desired` are aborted, and handles for new
    /// ATAs are started. O(N) over targets — same pattern as the
    /// account-trigger and feed-id reconcilers.
    pub async fn reconcile(&self, desired: &[VaultTarget]) {
        // Compute desired ATA pubkeys up front.
        let desired_atas: HashSet<Pubkey> = desired
            .iter()
            .map(|t| associated_token_address(&t.owner, &t.mint))
            .collect();

        // Unsubscribe any ATA that is no longer needed.
        let current: Vec<Pubkey> = self.handles.read().await.keys().copied().collect();
        for ata in &current {
            if !desired_atas.contains(ata) {
                self.unsubscribe(ata).await;
            }
        }

        // Subscribe to any ATA not yet handled.
        for target in desired {
            let ata = associated_token_address(&target.owner, &target.mint);
            if !self.handles.read().await.contains_key(&ata) {
                self.subscribe(target.clone()).await;
            }
        }
    }
}
