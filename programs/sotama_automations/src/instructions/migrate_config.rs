use anchor_lang::prelude::*;

use crate::state::{Config, DEFAULT_SWAP_FEE_BPS, DEFAULT_TIME_FEE_LAMPORTS_PER_DAY};

/// One-shot admin migration that ensures the `Config` PDA matches the
/// current `Config::INIT_SPACE` and seeds the fee-model fields
/// (`swap_fee_bps`, `time_fee_lamports_per_day`) with their launch
/// defaults. Idempotent: running it twice is a no-op once the account
/// is already at full size — Anchor's `realloc` constraint
/// shrinks/grows to the requested size and we re-assert the defaults.
///
/// Required only on devnet (which has a predecessor `Config` from an
/// earlier ship). Mainnet's first `initialize_config` writes the
/// current layout directly, so this ix is unused there.
///
/// Note: this ix uses `Account<Config>` for the realloc constraint,
/// which means Anchor has to be able to deserialize the existing bytes
/// against the *current* `Config` struct layout. Across a layout change
/// that removed a field and added two others (the v4.4 → v4.5 fee
/// transition), the existing bytes won't parse — operators on devnet
/// should re-initialize via the migrations/initialize script rather
/// than relying on this ix for that specific transition.
#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
        realloc = 8 + Config::INIT_SPACE,
        realloc::payer = admin,
        realloc::zero = false,
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<MigrateConfig>) -> Result<()> {
    require!(
        !ctx.accounts.config.shutdown,
        crate::errors::SotamaError::Shutdown
    );
    let admin = ctx.accounts.admin.key();
    let config = &mut ctx.accounts.config;
    // After realloc, the newly-grown bytes are zero. Seed the fee
    // fields with launch defaults; the admin can rotate via
    // `update_swap_fee_bps` and `update_time_fee_per_day` afterwards.
    config.treasury = admin;
    config.swap_fee_bps = DEFAULT_SWAP_FEE_BPS;
    config.time_fee_lamports_per_day = DEFAULT_TIME_FEE_LAMPORTS_PER_DAY;
    Ok(())
}
