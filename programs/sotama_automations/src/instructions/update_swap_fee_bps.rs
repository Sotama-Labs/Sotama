use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::state::{Config, MAX_SWAP_FEE_BPS};

#[derive(Accounts)]
pub struct UpdateSwapFeeBps<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<UpdateSwapFeeBps>, new_bps: u16) -> Result<()> {
    // Locked post-shutdown. The wind-down playbook calls for zeroing
    // the swap fee BEFORE flipping shutdown so any final fires don't
    // siphon the user's output during the grace window.
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require!(new_bps <= MAX_SWAP_FEE_BPS, SotamaError::SwapFeeTooLarge);
    ctx.accounts.config.swap_fee_bps = new_bps;
    Ok(())
}
