use solana_sdk::pubkey::Pubkey;

use crate::state::{ActionSpec, TriggerSpec};

/// Snapshot of an on-chain automation that the keeper hot-paths against.
/// Cloned freely; full ActionSpec/TriggerSpec carried so the executor
/// doesn't need to re-fetch.
#[derive(Debug, Clone)]
pub struct AutomationCtx {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub trigger: TriggerSpec,
    pub action: ActionSpec,
}

impl AutomationCtx {
    /// Watched account if this is an AccountActivity trigger, else None.
    pub fn watched_account(&self) -> Option<Pubkey> {
        match &self.trigger {
            TriggerSpec::AccountActivity { account, .. } => Some(*account),
            _ => None,
        }
    }

    /// Stake account referenced (by trigger or action), if any.
    pub fn stake_account(&self) -> Option<Pubkey> {
        if let TriggerSpec::StakingReward { stake_account, .. } = &self.trigger {
            return Some(*stake_account);
        }
        match &self.action {
            ActionSpec::StakeRestake { stake_account, .. } => Some(*stake_account),
            ActionSpec::StakeWithdrawReward { stake_account, .. } => Some(*stake_account),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct TriggerEvent {
    /// Diagnostic source (e.g. "account_subscriber", "price_watcher").
    pub source: &'static str,
    /// Free-form correlation token — tx signature for account triggers,
    /// "{feed}:{slot}" for price triggers, "{stake}:{epoch}" for stake.
    pub correlation: String,
    pub matches: Vec<AutomationCtx>,
}
