//! Lazy cache for `Config.treasury`.
//!
//! The Sotama program's treasury pubkey rarely rotates (admin-only,
//! gated by `update_treasury`). The keeper only needs to know it to
//! derive the treasury's ATA for the protocol swap fee. Fetching the
//! Config account on every fire would be wasteful; doing it at keeper
//! startup tightly couples the boot path to RPC. So we resolve lazily
//! on first read, cache forever for this process, and refresh on
//! demand if the admin signals a rotation (operator restarts the
//! keeper).
//!
//! Reads the value via a fixed-offset byte slice rather than borsh-
//! deserializing the full Config — keeps the keeper independent of
//! the on-chain layout's other fields.

use anyhow::{anyhow, Result};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tracing::info;

/// Byte offset of `Config.treasury` inside the account data. Matches
/// the field order in `programs/sotama_automations/src/state.rs`:
///   8 (discriminator) + 32 (admin) + 32 (keeper) + 1 (paused)
///   + 8 (automation_count) + 1 (bump) = 82.
const TREASURY_OFFSET: usize = 8 + 32 + 32 + 1 + 8 + 1;

#[derive(Clone)]
pub struct TreasuryHandle {
    inner: Arc<OnceCell<Pubkey>>,
}

impl TreasuryHandle {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(OnceCell::new()),
        }
    }

    /// Resolve and cache. The closure under `get_or_try_init` only runs
    /// on the first caller; subsequent reads hit the cache.
    pub async fn get(&self, rpc: &RpcClient, config_pda: &Pubkey) -> Result<Pubkey> {
        self.inner
            .get_or_try_init(|| async {
                let acct = rpc
                    .get_account(config_pda)
                    .await
                    .map_err(|e| anyhow!("get_account(Config {config_pda}): {e}"))?;
                if acct.data.len() < TREASURY_OFFSET + 32 {
                    return Err(anyhow!(
                        "Config account too small ({} bytes); expected ≥ {}",
                        acct.data.len(),
                        TREASURY_OFFSET + 32
                    ));
                }
                let bytes: [u8; 32] = acct.data[TREASURY_OFFSET..TREASURY_OFFSET + 32]
                    .try_into()
                    .expect("len-checked slice");
                let treasury = Pubkey::new_from_array(bytes);
                info!(%treasury, "TreasuryHandle: resolved Config.treasury");
                Ok::<Pubkey, anyhow::Error>(treasury)
            })
            .await
            .copied()
    }
}

impl Default for TreasuryHandle {
    fn default() -> Self {
        Self::new()
    }
}
