use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::state::Config;

/// One-way kill switch. Sets `Config.shutdown = true`. Admin only.
///
/// After this lands:
///   * `execute_*` and `create_automation_*` revert (no new fires, no
///     new rules).
///   * `update_treasury`, `update_close_fee`, `update_admin`,
///     `migrate_config` revert (admin governance is frozen on the
///     fields a compromised admin could exploit to redirect rent).
///   * `admin_close_automation*` becomes callable so the admin can
///     unwind orphaned PDAs that didn't self-close in the grace
///     window. Deposits flow back to owners; rent flows to
///     `Config.treasury`.
///   * `update_keeper` and `set_paused` stay allowed but are
///     functionally moot (execute_* is already blocked).
///
/// Reverts on a second invocation (`ShutdownAlreadySet`) so a buggy
/// or compromised admin can't toggle the flag in attempts to game
/// timing.
#[derive(Accounts)]
pub struct SetShutdown<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,
}

pub fn handler(ctx: Context<SetShutdown>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.shutdown, SotamaError::ShutdownAlreadySet);
    config.shutdown = true;
    // Note: `paused` is intentionally NOT touched here. `paused` and
    // `shutdown` are independent gates. Every execute_/create_ ix
    // checks both. The wind-down runbook recommends `set_paused(true)`
    // BEFORE `set_shutdown` so users get the "pause first, then
    // shutdown" UX signal — but on-chain, either gate alone is
    // sufficient to block fires.
    Ok(())
}
