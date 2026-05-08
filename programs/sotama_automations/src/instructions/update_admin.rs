use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::state::Config;

/// Rotate `Config.admin`. Required for handing off control to a Squads
/// multisig (or any other rotation). Admin only.
///
/// **Rejected when `Config.shutdown == true`.** Squads/governance
/// transitions must happen during normal operation. Allowing admin
/// rotation post-shutdown would let a compromised admin reassign the
/// admin role to themselves and then admin-close PDAs draining rent
/// to a treasury they control via a separate `update_treasury` ix —
/// but `update_treasury` is also locked post-shutdown, so this is
/// belt-and-suspenders. We still enforce both gates because the cost
/// of a redundant check is zero and the cost of a missed gate is the
/// kill-switch's entire integrity story.
#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.shutdown, SotamaError::Shutdown);
    config.admin = new_admin;
    Ok(())
}
