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
}

#[event]
pub struct AutomationExecuted {
    pub pubkey: Pubkey,
    pub action_kind: u8,
    /// Lamports moved (or token base units for SPL). Keeper-provided when
    /// the amount is dynamic (stake reward), otherwise the static action
    /// amount.
    pub amount: u64,
}

#[event]
pub struct AutomationClosed {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub refund_lamports: u64,
}
