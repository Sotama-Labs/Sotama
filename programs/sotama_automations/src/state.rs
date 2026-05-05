use anchor_lang::prelude::*;

pub const MIN_AMOUNT_LAMPORTS: u64 = 1_000_000;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub paused: bool,
    pub automation_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Automation {
    pub owner: Pubkey,
    pub nonce: u64,
    pub watched_account: Pubkey,
    pub destination: Pubkey,
    pub amount_lamports: u64,
    pub executed: bool,
    pub created_at: i64,
    pub executed_at: i64,
    pub bump: u8,
}
