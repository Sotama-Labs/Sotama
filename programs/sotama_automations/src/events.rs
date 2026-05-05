use anchor_lang::prelude::*;

#[event]
pub struct AutomationCreated {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub watched_account: Pubkey,
    pub destination: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct AutomationExecuted {
    pub pubkey: Pubkey,
    pub destination: Pubkey,
    pub amount_lamports: u64,
}

#[event]
pub struct AutomationClosed {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub refund_lamports: u64,
}
