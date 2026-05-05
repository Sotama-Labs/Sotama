use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;

use crate::program::automation_discriminator;

/// Borsh-mirror of the on-chain `Automation` account, excluding the 8-byte
/// Anchor discriminator prefix. Layout MUST match
/// `programs/sotama_automations/src/state.rs::Automation`.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub struct Automation {
    pub owner: Pubkey,
    pub nonce: u64,
    pub watched_account: Pubkey,
    pub destination: Pubkey,
    pub amount_lamports: u64,
    pub executed: bool,
    pub created_at: i64,
    pub executed_at: i64,
    pub bump: u8,
}

impl Automation {
    pub fn from_account_data(data: &[u8]) -> anyhow::Result<Self> {
        if data.len() < 8 {
            anyhow::bail!("account data too short ({})", data.len());
        }
        let (disc, body) = data.split_at(8);
        if disc != automation_discriminator() {
            anyhow::bail!("discriminator mismatch");
        }
        Self::try_from_slice(body).map_err(|e| anyhow::anyhow!("borsh decode failed: {e}"))
    }
}
