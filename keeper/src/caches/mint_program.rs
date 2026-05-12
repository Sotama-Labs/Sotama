//! Lazy mint → token-program-id cache.
//!
//! Token-2022 support requires the keeper to know which program owns
//! each mint, because:
//!   • ATA derivation uses the token program as a seed input — legacy
//!     and Token-2022 ATAs for the same (owner, mint) are different
//!     PDAs and BOTH could exist for the same wallet.
//!   • `execute_swap` takes the output mint's program in its outer
//!     account list, and Anchor enforces it matches the mint's owner.
//!
//! Resolving this requires one `getAccountInfo` per mint, but the
//! result never changes for a given mint (program ownership is set at
//! mint creation and immutable). So we lazy-resolve, cache forever,
//! and provide a single `resolve` API the executor and bridge
//! dispatcher both consume.

use anyhow::{anyhow, Result};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::debug;

/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` — legacy SPL Token program.
fn legacy_spl() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}

/// `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` — Token-2022 program.
fn token_2022() -> Pubkey {
    Pubkey::from_str("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap()
}

#[derive(Clone, Default)]
pub struct MintProgramCache {
    inner: Arc<RwLock<HashMap<Pubkey, Pubkey>>>,
}

impl MintProgramCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns the token program that owns `mint`. First call for a
    /// new mint hits RPC; subsequent calls return the cached value.
    /// Rejects any program that isn't one of the two known SPL token
    /// program IDs — protects against a misconfigured mint that lives
    /// under some other program (which we couldn't safely route
    /// through Sotama's `transfer_checked` anyway).
    pub async fn resolve(&self, rpc: &RpcClient, mint: &Pubkey) -> Result<Pubkey> {
        if let Some(prog) = self.inner.read().await.get(mint).copied() {
            return Ok(prog);
        }
        let acct = rpc
            .get_account(mint)
            .await
            .map_err(|e| anyhow!("get_account({mint}) for mint-program lookup: {e}"))?;
        let owner = acct.owner;
        let known = [legacy_spl(), token_2022()];
        if !known.contains(&owner) {
            return Err(anyhow!(
                "mint {mint} is owned by {owner}; not a known SPL token program (legacy or 2022)"
            ));
        }
        self.inner.write().await.insert(*mint, owner);
        debug!(%mint, %owner, "MintProgramCache: resolved");
        Ok(owner)
    }
}
