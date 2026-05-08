use anchor_lang::prelude::*;

#[event]
pub struct AutomationCreated {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    /// `0` = AccountActivity, `1` = TokenPrice, `2` = StakingReward — keeps
    /// the event slim while still letting indexers route to the right
    /// subscriber without re-fetching the account.
    pub trigger_kind: u8,
    /// `0` = TransferSol, `1` = TransferSpl, `2` = StakeRestake,
    /// `3` = StakeWithdrawReward.
    pub action_kind: u8,
    /// Watched / feed / stake account, depending on trigger_kind.
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
    /// Lamports moved (or token base units for SPL). Keeper-provided when
    /// the amount is dynamic (stake reward), otherwise the static action
    /// amount.
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
}
