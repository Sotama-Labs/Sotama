use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{Automation, Config};

/// Admin-driven close for `TransferSol` automations. Only callable
/// when `Config.shutdown == true` — i.e. the kill switch has been
/// pulled and the wind-down is in progress.
///
/// Lamport split:
///   * Owner receives `pda_lamports - rent_min` (the user's SOL deposit).
///   * Treasury receives the PDA's rent-exempt minimum.
///
/// **Auth:** the `admin` signer must equal `Config.admin`. Owners are
/// expected to self-close via `close_automation` (no admin-key required;
/// gives them full rent + deposit). This ix exists for the orphans that
/// didn't self-close in the grace window before `set_shutdown` flipped.
///
/// Token-action automations (SPL transfer, Swap) route to
/// `admin_close_automation_spl` / `admin_close_automation_swap` instead;
/// those need the ATA bookkeeping.
#[derive(Accounts)]
pub struct AdminCloseAutomation<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: address-checked against `automation.owner`. Receives the
    /// deposit portion of the PDA's lamports. No signer; admin
    /// authority alone suffices once `shutdown == true`.
    #[account(
        mut,
        address = automation.owner @ SotamaError::WrongDestination,
    )]
    pub owner: AccountInfo<'info>,

    #[account(
        mut,
        close = treasury,
        seeds = [
            b"automation",
            owner.key().as_ref(),
            &automation.nonce.to_le_bytes(),
        ],
        bump = automation.bump,
        has_one = owner,
    )]
    pub automation: Account<'info, Automation>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: address-checked against `config.treasury`. Receives the
    /// PDA's rent-exempt minimum on close (Anchor's `close = treasury`).
    #[account(
        mut,
        address = config.treasury @ SotamaError::WrongTreasury,
    )]
    pub treasury: AccountInfo<'info>,
}

pub fn handler(ctx: Context<AdminCloseAutomation>) -> Result<()> {
    require!(ctx.accounts.config.shutdown, SotamaError::NotShutdown);

    // Pre-Anchor-close: peel off the deposit portion of the PDA's
    // lamports (everything above rent_exempt minimum) and send it to
    // the owner. Anchor's `close = treasury` then sweeps the remaining
    // rent_min to treasury when the handler returns.
    let automation_info = ctx.accounts.automation.to_account_info();
    let pda_balance = automation_info.lamports();
    let rent_min = Rent::get()?.minimum_balance(8 + Automation::INIT_SPACE);
    let deposit = pda_balance.saturating_sub(rent_min);

    if deposit > 0 {
        let owner_info = ctx.accounts.owner.to_account_info();
        let new_pda_balance = pda_balance
            .checked_sub(deposit)
            .ok_or(error!(SotamaError::WrongDestination))?;
        let new_owner_balance = owner_info
            .lamports()
            .checked_add(deposit)
            .ok_or(error!(SotamaError::WrongDestination))?;
        **automation_info.try_borrow_mut_lamports()? = new_pda_balance;
        **owner_info.try_borrow_mut_lamports()? = new_owner_balance;
    }

    if !ctx.accounts.automation.finished {
        emit!(AutomationFinished {
            automation: ctx.accounts.automation.key(),
            reason: 1, // closed
        });
    }

    emit!(AutomationClosed {
        automation: ctx.accounts.automation.key(),
        owner: ctx.accounts.owner.key(),
        // For admin-close, "refund_lamports" is the deposit returned to
        // the owner; "fee_lamports" is the rent_min flowing to treasury.
        refund_lamports: deposit,
        fee_lamports: rent_min.min(pda_balance),
    });

    Ok(())
}
