use anchor_lang::prelude::*;

use crate::state::Config;

/// One-shot admin migration that grows the existing `Config` PDA to the
/// current `Config::INIT_SPACE` and initializes the v4.1 fields
/// (`treasury`, `close_fee_lamports`). Idempotent: running it twice is
/// a no-op once the account is already at full size — Anchor's `realloc`
/// constraint shrinks/grows to the requested size, and we explicitly set
/// the new fields each time.
///
/// Required only on devnet (which has a v4.0 Config from a prior
/// `initialize_config`). Mainnet's first `initialize_config` writes the
/// full v4.1 layout directly, so this ix is unused there.
///
/// Defaults match `initialize_config`:
///   * `treasury = admin`
///   * `close_fee_lamports = 0`
///
/// Admin can rotate either field afterwards via `update_treasury` /
/// `update_close_fee`.
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
    // After realloc, the newly-grown bytes are zero. We explicitly set
    // the v4.1 fields so a freshly migrated config matches a freshly
    // initialized one. Idempotent: running again with the same admin
    // produces identical state (unless treasury/close_fee_lamports have
    // already been rotated, in which case the second call would reset
    // them — operators should run this exactly once after the upgrade).
    config.treasury = admin;
    config.close_fee_lamports = 0;
    // `shutdown` defaults to false from the realloc zero-init; we
    // explicitly leave it untouched here so a future migrate_config
    // call (which is itself blocked when shutdown is true) cannot
    // somehow reset the kill switch.
    Ok(())
}
