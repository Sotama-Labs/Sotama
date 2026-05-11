use anchor_lang::prelude::*;

#[event]
pub struct AutomationCreated {
    pub automation: Pubkey,
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
    pub automation: Pubkey,
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
    pub automation: Pubkey,
    pub owner: Pubkey,
    /// Lamports returned to the owner. For `TransferSol` rules that
    /// never fired, this includes the unfired SOL deposit (above-rent
    /// excess). For SPL/Swap rules this is `0` — token deposits flow
    /// back via the ATA transfer earlier in the same ix, and the PDA's
    /// own lamports are all rent (routed to treasury, not the owner).
    pub refund_lamports: u64,
    /// Rent-exempt portion of the PDA routed to `Config.treasury`.
    /// This is the protocol's per-close fee.
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

/// Emitted at the end of every successful `execute_swap` (after Jupiter CPI completes).
/// Carries the actual swap input/output amounts so the keeper can compute the effective
/// fill price for downstream `PriceRelativeToFill` triggers.
#[event]
pub struct AutomationFilled {
    pub automation: Pubkey,
    /// SPL amount of the input mint that was swapped.
    pub input_amount: u64,
    /// SPL amount of the output mint that was received (post-slippage).
    pub output_amount: u64,
    /// Slot at which the fill occurred (for staleness checks).
    pub fill_slot: u64,
}
