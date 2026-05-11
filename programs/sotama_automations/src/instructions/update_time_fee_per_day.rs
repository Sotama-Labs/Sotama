use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::state::{Config, MAX_TIME_FEE_LAMPORTS_PER_DAY};

#[derive(Accounts)]
pub struct UpdateTimeFeePerDay<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<UpdateTimeFeePerDay>, new_lamports_per_day: u64) -> Result<()> {
    // Locked post-shutdown — same reasoning as `update_swap_fee_bps`.
    // After shutdown no new rules can be created anyway, but freezing
    // the rate keeps the surface tight.
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require!(
        new_lamports_per_day <= MAX_TIME_FEE_LAMPORTS_PER_DAY,
        SotamaError::TimeFeeTooLarge
    );
    ctx.accounts.config.time_fee_lamports_per_day = new_lamports_per_day;
    Ok(())
}
