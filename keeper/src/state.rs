use borsh::{BorshDeserialize, BorshSerialize};
use sha2::{Digest, Sha256};
use solana_sdk::pubkey::Pubkey;

use crate::program::automation_discriminator;

/// Oracle source byte mirror of the on-chain `oracle_source` mod.
/// MUST match `programs/sotama_automations/src/state.rs::oracle_source`.
pub mod oracle_source {
    pub const PYTH: u8 = 0;
    pub const JUPITER: u8 = 1;
}

/// Borsh-mirror of the on-chain `TriggerSpec` enum. Layout MUST match
/// `programs/sotama_automations/src/state.rs::TriggerSpec`.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub enum TriggerSpec {
    AccountActivity {
        account: Pubkey,
        mint: Option<Pubkey>,
        kind: u8,
    },
    AssetPrice {
        /// 32-byte feed id. Interpretation depends on `source`:
        /// Pyth feed id (PYTH=0), SPL mint (JUPITER=1), …
        feed: Pubkey,
        /// `None` = USD-denominated (single-feed compare).
        /// `Some(mint)` = compare `feed_price / jupiter_quote(mint, USDC)`
        /// against `threshold * 10^expo`.
        quote_mint: Option<Pubkey>,
        comparator: u8,
        threshold: i64,
        expo: i32,
        /// Oracle adapter to dispatch to. See `oracle_source` mod.
        source: u8,
    },
    /// Wall-clock delay since `Automation.created_at`. The keeper's
    /// `time_watcher` ticks every minute and fires any rule whose
    /// `created_at + duration_secs <= now`.
    TimeElapsed { duration_secs: u32 },
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
    Swap {
        input_mint: Pubkey,
        output_mint: Pubkey,
        destination: Pubkey,
        amount_in: u64,
        min_amount_out: u64,
        linked_downstream: Option<Pubkey>,
        link_fee_deposit: u64,
        /// Whether this swap should consume the output of an upstream
        /// swap (bridge mode) rather than a fixed `amount_in`.
        consume_upstream_output: bool,
    },
}

/// Borsh-mirror of the on-chain `Cadence` enum.
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub enum Cadence {
    Once,
    Repeat { total: u32 },
    Until { unix_deadline: i64 },
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
    pub cadence: Cadence,
    pub executions: u32,
    pub min_interval_secs: u32,
    pub finished: bool,
    pub created_at: i64,
    pub executed_at: i64,
    pub bump: u8,
    /// Per-PDA opt-in for `execute_fee_topup`. Mirrors the v4.1 field
    /// carved from the original `_reserved` budget.
    pub fee_topup_enabled: bool,
    /// Per-PDA opt-in for `execute_bridge`. Populated by deserializing
    /// the on-chain Automation account.
    pub bridge_enabled: bool,
    /// 30 bytes of forward-compat padding (was 32 pre-v4.1; 2 bytes
    /// moved into `fee_topup_enabled` and `bridge_enabled` above).
    pub _reserved: [u8; 30],
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
            TriggerSpec::AssetPrice {
                feed,
                quote_mint,
                comparator,
                threshold,
                expo,
                source,
            } => Monitor::Price {
                feed: *feed,
                quote_mint: *quote_mint,
                comparator: *comparator,
                threshold: *threshold,
                expo: *expo,
                source: *source,
            },
            TriggerSpec::TimeElapsed { duration_secs } => Monitor::Time {
                duration_secs: *duration_secs,
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
        /// None = USD-denominated; Some(mint) = ratio against
        /// Jupiter-probed mint price.
        quote_mint: Option<Pubkey>,
        comparator: u8,
        threshold: i64,
        expo: i32,
        /// `oracle_source` byte. Picks which adapter the dispatcher
        /// routes this trigger to (Pyth Hermes/Lazer, Jupiter, …).
        source: u8,
    },
    Time {
        duration_secs: u32,
    },
}

// ---------------------------------------------------------------------------
// Anchor event mirrors — must match programs/sotama_automations/src/events.rs
// byte-for-byte. Used by the keeper's log decoder (Task 8).
// ---------------------------------------------------------------------------

/// Mirror of `AutomationCreated` event.
/// Field order mirrors the on-chain layout in events.rs exactly.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AutomationCreatedEvent {
    pub automation: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub trigger_kind: u8,
    pub action_kind: u8,
    pub trigger_pubkey: Pubkey,
    pub cadence_kind: u8,
}

/// Mirror of `AutomationUpdated` event.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AutomationUpdatedEvent {
    pub automation: Pubkey,
    pub change_kind: u8,
}

/// Mirror of `AutomationFinished` event.
#[derive(BorshSerialize, BorshDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AutomationFinishedEvent {
    pub automation: Pubkey,
    pub reason: u8,
}

/// Compute the Anchor event discriminator: `sha256("event:<EventName>")[..8]`.
pub fn anchor_event_discriminator(name: &str) -> [u8; 8] {
    let mut h = Sha256::new();
    h.update(format!("event:{}", name).as_bytes());
    let out = h.finalize();
    let mut d = [0u8; 8];
    d.copy_from_slice(&out[..8]);
    d
}

#[cfg(test)]
mod tests_events {
    use super::*;

    #[test]
    fn discriminator_matches_anchor_format() {
        let d = anchor_event_discriminator("AutomationCreated");
        assert_eq!(d.len(), 8);
        assert_eq!(d, anchor_event_discriminator("AutomationCreated"));
        assert_ne!(d, anchor_event_discriminator("AutomationUpdated"));
    }

    #[test]
    fn round_trips_created_event() {
        let ev = AutomationCreatedEvent {
            automation: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            nonce: 42,
            trigger_kind: 1,
            action_kind: 4,
            trigger_pubkey: Pubkey::new_unique(),
            cadence_kind: 2,
        };
        let bytes = borsh::to_vec(&ev).unwrap();
        let back = AutomationCreatedEvent::try_from_slice(&bytes).unwrap();
        assert_eq!(ev, back);
    }
}
