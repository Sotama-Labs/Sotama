use anchor_lang::prelude::*;

use crate::state::{Config, DEFAULT_SWAP_FEE_BPS, DEFAULT_TIME_FEE_LAMPORTS_PER_DAY};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeConfig>, keeper: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.keeper = keeper;
    config.paused = false;
    config.automation_count = 0;
    config.bump = ctx.bumps.config;
    // Default treasury = admin so swap-fee + close-rent revenue lands
    // somewhere sensible from day one. Rotate via `update_treasury`
    // once a dedicated fee-collection wallet (or Squads) is
    // provisioned.
    config.treasury = ctx.accounts.admin.key();
    // Launch fee defaults — see DEFAULT_* constants in state.rs.
    config.swap_fee_bps = DEFAULT_SWAP_FEE_BPS;
    config.time_fee_lamports_per_day = DEFAULT_TIME_FEE_LAMPORTS_PER_DAY;
    // Kill switch starts disarmed. One-way flip via `set_shutdown`.
    config.shutdown = false;
    Ok(())
}
