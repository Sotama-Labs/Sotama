use borsh::{BorshDeserialize, BorshSerialize};
use solana_sdk::pubkey::Pubkey;

use crate::program::automation_discriminator;

/// Borsh-mirror of the on-chain `TriggerSpec` enum. Layout MUST match
/// `programs/sotama_automations/src/state.rs::TriggerSpec`.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub enum TriggerSpec {
    AccountActivity {
        account: Pubkey,
        mint: Option<Pubkey>,
        kind: u8,
    },
    TokenPrice {
        feed: Pubkey,
        comparator: u8,
        threshold: i64,
        expo: i32,
    },
    StakingReward {
        stake_account: Pubkey,
        mode: u8,
        value: u64,
    },
}

/// Borsh-mirror of the on-chain `ActionSpec` enum.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub enum ActionSpec {
    TransferSol {
        destination: Pubkey,
        amount: u64,
    },
    TransferSpl {
        destination: Pubkey,
        mint: Pubkey,
        amount: u64,
    },
    StakeRestake {
        stake_account: Pubkey,
        vote_account: Pubkey,
    },
    StakeWithdrawReward {
        stake_account: Pubkey,
        destination: Pubkey,
    },
}

/// Borsh-mirror of the on-chain `Automation` account, excluding the 8-byte
/// Anchor discriminator prefix. Layout MUST match
/// `programs/sotama_automations/src/state.rs::Automation`.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub struct Automation {
    pub owner: Pubkey,
    pub nonce: u64,
    pub trigger: TriggerSpec,
    pub action: ActionSpec,
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
        // Anchor's `init` allocates space for the LARGEST enum variant.
        // Smaller variants leave trailing zero-bytes in the account data.
        // `try_from_slice` errors on those, so we use the streaming
        // `deserialize` reader and ignore leftover bytes.
        let mut cursor: &[u8] = body;
        Self::deserialize(&mut cursor).map_err(|e| anyhow::anyhow!("borsh decode failed: {e}"))
    }

    /// What kind of off-chain monitor this automation needs.
    pub fn monitor(&self) -> Monitor {
        match &self.trigger {
            TriggerSpec::AccountActivity { account, kind, .. } => Monitor::Account {
                watched: *account,
                swap: *kind == 1,
            },
            TriggerSpec::TokenPrice {
                feed,
                comparator,
                threshold,
                expo,
            } => Monitor::Price {
                feed: *feed,
                comparator: *comparator,
                threshold: *threshold,
                expo: *expo,
            },
            TriggerSpec::StakingReward {
                stake_account,
                mode,
                value,
            } => Monitor::Stake {
                stake_account: *stake_account,
                amount_mode: *mode == 0,
                value: *value,
            },
        }
    }
}

#[derive(Debug, Clone)]
pub enum Monitor {
    Account {
        watched: Pubkey,
        /// Whether the trigger is the swap variant (kind=1) — affects how
        /// the keeper filters notifications. Both variants share the same
        /// transactionSubscribe channel.
        swap: bool,
    },
    Price {
        feed: Pubkey,
        comparator: u8,
        threshold: i64,
        expo: i32,
    },
    Stake {
        stake_account: Pubkey,
        amount_mode: bool,
        value: u64,
    },
}
