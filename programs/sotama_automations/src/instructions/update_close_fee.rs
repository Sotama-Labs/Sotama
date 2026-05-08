use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::state::{Config, MAX_CLOSE_FEE_LAMPORTS};

#[derive(Accounts)]
pub struct UpdateCloseFee<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<UpdateCloseFee>, new_fee_lamports: u64) -> Result<()> {
    // Locked post-shutdown. The wind-down playbook calls for zeroing
    // the close fee BEFORE flipping shutdown so users have a no-fee
    // self-close grace window; once shutdown lands, the fee is frozen
    // at whatever value was last set (typically 0).
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require!(
        new_fee_lamports <= MAX_CLOSE_FEE_LAMPORTS,
        SotamaError::FeeTooLarge
    );
    ctx.accounts.config.close_fee_lamports = new_fee_lamports;
    Ok(())
}
