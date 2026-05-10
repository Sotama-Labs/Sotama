use anchor_lang::prelude::*;

#[event]
pub struct AutomationCreated {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    /// `0` = AccountActivity, `1` = AssetPrice — keeps the event slim
    /// while still letting indexers route to the right subscriber
    /// without re-fetching the account.
    pub trigger_kind: u8,
    /// `0` = TransferSol, `1` = TransferSpl, `4` = Swap.
    pub action_kind: u8,
    /// Watched / feed account, depending on trigger_kind.
    pub trigger_pubkey: Pubkey,
    /// `0` = Once (If), `1` = Repeat (For), `2` = Until (While). Lets the
    /// indexer render the right control-flow icon without decoding the
    /// account's full Cadence payload.
    pub cadence_kind: u8,
}

#[event]
pub struct AutomationExecuted {
    pub pubkey: Pubkey,
    pub action_kind: u8,
    /// Lamports moved (or token base units for SPL).
    pub amount: u64,
    /// 1-indexed run count after this fire (1 = first fire). Lets indexers
    /// distinguish "fire 3 of 10" from "first fire" without re-fetching the
    /// account.
    pub executions: u32,
    /// True iff this fire put the automation into its terminal state — i.e.
    /// the keeper should stop polling it.
    pub finished: bool,
}

#[event]
pub struct AutomationClosed {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub refund_lamports: u64,
    /// Lamports diverted to `Config.treasury` before the owner refund.
    /// `0` when `Config.close_fee_lamports == 0` or when the PDA had no
    /// excess lamports above rent-exempt minimum to cover the fee.
    pub fee_lamports: u64,
}

/// Emitted when a mutable field on a live automation is updated. The
/// keeper can use this to invalidate its cached copy of the rule without
/// re-fetching all accounts via getProgramAccounts.
///
/// `change_kind` codes:
///   0 = trigger updated
///   1 = action updated
///   2 = cadence updated
///   3 = link (linked_downstream / link_fee_deposit) updated
#[event]
pub struct AutomationUpdated {
    pub automation: Pubkey,
    pub change_kind: u8,
}

/// Emitted when an automation reaches its terminal state, either by
/// firing its last allowed execution (`reason = 0`) or by being
/// explicitly closed by the owner or admin (`reason = 1`).
///
/// `reason` codes:
///   0 = fired_terminal  — cadence exhausted (Once fired, Repeat hit total, Until past deadline)
///   1 = closed          — owner or admin called close_automation*
///   2 = error           — reserved for keeper-side error annotation (not emitted on-chain today)
///
/// The keeper subscribes to this event to prune finished automations
/// from its active polling set without a full getProgramAccounts scan.
#[event]
pub struct AutomationFinished {
    pub automation: Pubkey,
    /// `0` = fired_terminal, `1` = closed, `2` = error
    pub reason: u8,
}
