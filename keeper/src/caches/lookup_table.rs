//! Address-lookup-table account cache.
//!
//! Jupiter publishes a small set of stable lookup tables that every
//! routed swap references via `addressesByLookupTableAddress` in the
//! `/swap/v2/build` response. The table *contents* (the list of
//! addresses each ALT holds) change only when Jupiter republishes —
//! daily at most. So we fetch each ALT's account data once via
//! `getMultipleAccounts`, keep the deserialized
//! `AddressLookupTableAccount` in memory, and refresh after a TTL.
//!
//! Shared across the executor and bridge dispatcher so N rules firing
//! in the same minute collapse to 1 RPC fetch per distinct ALT — which
//! matters under the Jupiter Developer tier's 10 rpm budget and Helius
//! RPC quotas alike.
//!
//! Invariants:
//! - Cache misses fan out to a single `getMultipleAccounts` (batched).
//! - Cache hits do not touch the network.
//! - Stale entries (>TTL) are refreshed lazily on next access; we don't
//!   spawn a background refresher because ALT churn is rare and the
//!   miss penalty is one RPC call per refresh window.

use anyhow::{anyhow, Result};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::address_lookup_table::state::AddressLookupTable;
use solana_sdk::address_lookup_table::AddressLookupTableAccount;
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
use tracing::{debug, warn};

/// How long a resolved ALT entry stays "fresh" before the next access
/// re-fetches it. 5 minutes is a tradeoff: Jupiter's published ALTs
/// rarely change within a window, but pinning forever would miss new
/// route additions if Jupiter adds an AMM to an existing table.
pub const ALT_CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct Entry {
    account: AddressLookupTableAccount,
    fetched_at: Instant,
}

/// Concurrent-safe cache. Backed by a single `RwLock<HashMap<…>>`; the
/// hot path is read-mostly (cache hit returns a clone of the cheap
/// `AddressLookupTableAccount` — a `Pubkey` + `Vec<Pubkey>`).
#[derive(Clone)]
pub struct LookupTableCache {
    inner: Arc<RwLock<HashMap<Pubkey, Entry>>>,
}

impl LookupTableCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Resolve a batch of ALT pubkeys to their loaded
    /// `AddressLookupTableAccount`s. Cache hits return immediately;
    /// misses (and stale entries) trigger a single batched
    /// `getMultipleAccounts` for the missing subset. Preserves the
    /// caller's input order so the returned slice can be passed
    /// directly into `MessageV0::try_compile`.
    pub async fn resolve_many(
        &self,
        rpc: &RpcClient,
        keys: &[Pubkey],
    ) -> Result<Vec<AddressLookupTableAccount>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }

        // Pass 1: read lock, collect fresh hits and the indexes of misses.
        let now = Instant::now();
        let mut resolved: Vec<Option<AddressLookupTableAccount>> = Vec::with_capacity(keys.len());
        let mut missing: Vec<Pubkey> = Vec::new();
        {
            let map = self.inner.read().await;
            for k in keys {
                match map.get(k) {
                    Some(entry) if now.duration_since(entry.fetched_at) < ALT_CACHE_TTL => {
                        resolved.push(Some(entry.account.clone()));
                    }
                    _ => {
                        resolved.push(None);
                        if !missing.contains(k) {
                            missing.push(*k);
                        }
                    }
                }
            }
        }

        if !missing.is_empty() {
            debug!(
                missing = missing.len(),
                hits = resolved.iter().filter(|r| r.is_some()).count(),
                "LookupTableCache: fetching missing ALTs"
            );
            let fetched = fetch_lookup_tables(rpc, &missing).await?;

            // Pass 2: write lock, fill the cache and patch up the
            // resolved Vec with the freshly fetched accounts.
            let mut map = self.inner.write().await;
            let now2 = Instant::now();
            for (k, account) in fetched.iter() {
                map.insert(
                    *k,
                    Entry {
                        account: account.clone(),
                        fetched_at: now2,
                    },
                );
            }
            for (i, k) in keys.iter().enumerate() {
                if resolved[i].is_none() {
                    if let Some(acct) = fetched.get(k) {
                        resolved[i] = Some(acct.clone());
                    } else {
                        return Err(anyhow!("ALT {k} not returned by getMultipleAccounts"));
                    }
                }
            }
        }

        Ok(resolved.into_iter().map(|o| o.expect("filled above")).collect())
    }

    /// Test-only direct insert. Public to allow integration-test
    /// seeding without going through RPC.
    #[cfg(test)]
    pub async fn insert_for_test(&self, key: Pubkey, account: AddressLookupTableAccount) {
        self.inner.write().await.insert(
            key,
            Entry {
                account,
                fetched_at: Instant::now(),
            },
        );
    }

    #[cfg(test)]
    pub async fn len(&self) -> usize {
        self.inner.read().await.len()
    }
}

impl Default for LookupTableCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Network fetch: pull the raw account data for each ALT and
/// deserialize it into the SDK's `AddressLookupTable` view. Returns
/// only the ALTs that the RPC actually returned data for; the caller
/// errors if any requested key is missing.
async fn fetch_lookup_tables(
    rpc: &RpcClient,
    keys: &[Pubkey],
) -> Result<HashMap<Pubkey, AddressLookupTableAccount>> {
    let accounts = rpc
        .get_multiple_accounts(keys)
        .await
        .map_err(|e| anyhow!("getMultipleAccounts({} ALTs): {e}", keys.len()))?;

    let mut out = HashMap::with_capacity(keys.len());
    for (key, maybe_account) in keys.iter().zip(accounts.into_iter()) {
        let Some(account) = maybe_account else {
            warn!(alt = %key, "ALT account not found on-chain; skipping");
            continue;
        };
        let table = AddressLookupTable::deserialize(&account.data)
            .map_err(|e| anyhow!("deserialize ALT {key}: {e}"))?;
        out.insert(
            *key,
            AddressLookupTableAccount {
                key: *key,
                addresses: table.addresses.to_vec(),
            },
        );
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_account(key: Pubkey, n_addrs: usize) -> AddressLookupTableAccount {
        AddressLookupTableAccount {
            key,
            addresses: (0..n_addrs).map(|_| Pubkey::new_unique()).collect(),
        }
    }

    #[tokio::test]
    async fn cache_hit_after_insert() {
        let cache = LookupTableCache::new();
        let key = Pubkey::new_unique();
        cache.insert_for_test(key, dummy_account(key, 3)).await;
        assert_eq!(cache.len().await, 1);
    }

    #[tokio::test]
    async fn empty_input_returns_empty_without_rpc() {
        // Resolving an empty slice MUST NOT touch the RpcClient — we
        // intentionally pass a junk URL to catch any sneaky network use.
        let rpc = RpcClient::new("http://127.0.0.1:1".to_string());
        let cache = LookupTableCache::new();
        let resolved = cache.resolve_many(&rpc, &[]).await.expect("no fetch");
        assert!(resolved.is_empty());
    }
}
