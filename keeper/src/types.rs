use solana_sdk::pubkey::Pubkey;

use crate::state::{ActionSpec, TriggerSpec};

/// Snapshot of an on-chain automation that the keeper hot-paths against.
/// Cloned freely; full ActionSpec/TriggerSpec carried so the executor
/// doesn't need to re-fetch.
///
/// `created_at` and `nonce` are deterministic, immutable fields used by
/// the executor to enforce cross-user ordering: when N users' rules
/// fire on the same trigger event, the executor sorts by
/// `(created_at ASC, nonce ASC)` and processes them serially so the
/// oldest rule executes first, with intra-batch revalidation skipping
/// later rules whose trigger conditions no longer hold.
#[derive(Debug, Clone)]
pub struct AutomationCtx {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    /// Block timestamp (Unix seconds) at automation creation. Tie-break
    /// on `nonce` for determinism when multiple rules share a slot.
    pub created_at: i64,
    pub trigger: TriggerSpec,
    pub action: ActionSpec,
    /// Mirrors `Automation.bridge_enabled`. The bridge dispatcher reads
    /// this to decide whether to scan a PDA's token accounts for stuck
    /// non-input-mint tokens. Carried in `AutomationCtx` so the
    /// dispatcher doesn't have to refetch the on-chain account every
    /// tick — the indexer already pulls it during reconcile.
    pub bridge_enabled: bool,
}

impl AutomationCtx {
    /// Watched account if this is an AccountActivity trigger, else None.
    pub fn watched_account(&self) -> Option<Pubkey> {
        match &self.trigger {
            TriggerSpec::AccountActivity { account, .. } => Some(*account),
            _ => None,
        }
    }

    /// Vault accounts owned by this automation's PDA that the bridge
    /// dispatcher must scan. Only bridge-enabled Swap automations have a
    /// meaningful vault — the PDA itself holds token accounts that can
    /// accumulate stuck non-input-mint balances between chain legs.
    /// Returns the automation PDA when bridge_enabled, empty otherwise.
    pub fn vault_accounts(&self) -> Vec<Pubkey> {
        if self.bridge_enabled {
            vec![self.pubkey]
        } else {
            vec![]
        }
    }
}

#[derive(Debug, Clone)]
pub struct TriggerEvent {
    /// Diagnostic source (e.g. "account_subscriber", "price_watcher").
    pub source: &'static str,
    /// Free-form correlation token — tx signature for account triggers,
    /// "{feed}:{slot}" for price triggers.
    pub correlation: String,
    pub matches: Vec<AutomationCtx>,
    /// Link chain depth. 0 for events from the standalone monitors
    /// (subscriber, price_watcher); 1+ for events originated by
    /// `link_watcher` after observing an upstream fire.
    /// The executor uses this to bundle `execute_link_fee_debit` (only
    /// when depth > 0) and to enforce a depth cap (drops past 3).
    pub depth: u8,
}
