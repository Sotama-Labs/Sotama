use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::state::Config;

#[derive(Accounts)]
pub struct UpdateTreasury<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<UpdateTreasury>, new_treasury: Pubkey) -> Result<()> {
    // Locked post-shutdown so a compromised admin can't redirect the
    // treasury during an admin-close run. Set the final treasury
    // (e.g. Squads vault) before flipping `set_shutdown`.
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    ctx.accounts.config.treasury = new_treasury;
    Ok(())
}
