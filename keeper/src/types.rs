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
    /// Mirrors `Automation.executions`. Used by the indexer to compute
    /// `armed` for downstream chain links: a `consume_upstream_output`
    /// rule with an upstream whose `executions == 0` cannot fire yet
    /// because its input ATA is structurally empty.
    pub executions: u32,
    /// True when the rule is eligible to fire right now. Computed by
    /// the indexer after each reconcile. For `consume_upstream_output`
    /// Swap rules this means an upstream rule (one whose
    /// `linked_downstream` points at this pubkey) exists in the
    /// watched set AND has fired at least once. All other rules are
    /// always armed. Watchers consult this flag before adding a rule
    /// to a TriggerEvent so a tail-of-chain rule doesn't spam the
    /// executor every Pyth tick while its upstream hasn't fired yet.
    pub armed: bool,
}

/// Carries enough information for `VaultManager` to compute the ATA
/// address that should be subscribed to via accountSubscribe.
///
/// The ATA pubkey is `find_program_address([owner, spl_token_program,
/// mint], ata_program)` — deterministic from `(owner, mint)` alone, so
/// no RPC call is needed at subscribe time.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct VaultTarget {
    /// The SPL mint whose ATA we want to watch.
    pub mint: Pubkey,
    /// The automation PDA that owns the ATA.
    pub owner: Pubkey,
}

impl AutomationCtx {
    /// Watched account if this is an AccountActivity trigger, else None.
    pub fn watched_account(&self) -> Option<Pubkey> {
        match &self.trigger {
            TriggerSpec::AccountActivity { account, .. } => Some(*account),
            _ => None,
        }
    }

    /// Vault targets for this automation — one `VaultTarget` per mint
    /// that the PDA could accumulate. The `VaultManager` computes the
    /// ATA pubkey from each target and subscribes to it via
    /// accountSubscribe so balance changes land in `VaultCache`
    /// immediately rather than being discovered by polling.
    ///
    /// Only bridge-enabled Swap automations produce targets (the
    /// spec says ≤2: input mint + output mint). Non-bridge or
    /// non-Swap automations return empty — they never hold stuck
    /// token balances that need monitoring.
    pub fn vault_targets(&self) -> Vec<VaultTarget> {
        if !self.bridge_enabled {
            return vec![];
        }
        match &self.action {
            ActionSpec::Swap { input_mint, output_mint, .. } => {
                vec![
                    VaultTarget { mint: *input_mint, owner: self.pubkey },
                    VaultTarget { mint: *output_mint, owner: self.pubkey },
                ]
            }
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ActionSpec, Cadence, TriggerSpec};

    fn swap_ctx(bridge_enabled: bool) -> AutomationCtx {
        let pda = Pubkey::new_unique();
        let input_mint = Pubkey::new_unique();
        let output_mint = Pubkey::new_unique();
        AutomationCtx {
            pubkey: pda,
            owner: Pubkey::new_unique(),
            nonce: 0,
            created_at: 0,
            trigger: TriggerSpec::TimeElapsed { duration_secs: 60 },
            action: ActionSpec::Swap {
                input_mint,
                output_mint,
                destination: Pubkey::new_unique(),
                amount_in: 1_000_000,
                min_amount_out: 900_000,
                linked_downstream: None,
                link_fee_deposit: 0,
                consume_upstream_output: false,
            },
            bridge_enabled,
            executions: 0,
            armed: true,
        }
    }

    fn sol_ctx() -> AutomationCtx {
        AutomationCtx {
            pubkey: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            nonce: 0,
            created_at: 0,
            trigger: TriggerSpec::TimeElapsed { duration_secs: 60 },
            action: ActionSpec::TransferSol {
                destination: Pubkey::new_unique(),
                amount: 1_000_000,
            },
            bridge_enabled: true, // even if set, non-Swap should produce no targets
            executions: 0,
            armed: true,
        }
    }

    #[test]
    fn bridge_disabled_produces_no_targets() {
        let ctx = swap_ctx(false);
        assert!(ctx.vault_targets().is_empty());
    }

    #[test]
    fn bridge_enabled_swap_produces_two_targets() {
        let ctx = swap_ctx(true);
        let targets = ctx.vault_targets();
        assert_eq!(targets.len(), 2);
        // Both targets are owned by the automation PDA.
        for t in &targets {
            assert_eq!(t.owner, ctx.pubkey);
        }
        // The two targets carry distinct mints.
        assert_ne!(targets[0].mint, targets[1].mint);
    }

    #[test]
    fn bridge_enabled_non_swap_produces_no_targets() {
        let ctx = sol_ctx();
        assert!(ctx.vault_targets().is_empty());
    }

    #[test]
    fn vault_target_mints_match_action_mints() {
        let ctx = swap_ctx(true);
        let targets = ctx.vault_targets();
        let mints: Vec<Pubkey> = targets.iter().map(|t| t.mint).collect();
        if let ActionSpec::Swap { input_mint, output_mint, .. } = &ctx.action {
            assert!(mints.contains(input_mint));
            assert!(mints.contains(output_mint));
        } else {
            panic!("expected Swap action");
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
    /// Price snapshot the watcher used when it decided to fire. `Some`
    /// for price-driven triggers (AssetPrice / PriceRatio crossings from
    /// price_watcher, lazer_watcher, jupiter_watcher). `None` for
    /// non-price triggers (TimeElapsed, AccountActivity). Task 19 will
    /// wired into the executor (Task 19) to replace the revalidate re-fetch.
    pub snapshot: Option<crate::prices::cache::PriceSnapshot>,
}
