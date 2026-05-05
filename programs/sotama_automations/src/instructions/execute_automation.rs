use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::events::AutomationExecuted;
use crate::state::{Automation, Config};

#[derive(Accounts)]
pub struct ExecuteAutomation<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [
            b"automation",
            automation.owner.as_ref(),
            &automation.nonce.to_le_bytes(),
        ],
        bump = automation.bump,
        constraint = automation.destination == destination.key() @ SotamaError::WrongDestination,
    )]
    pub automation: Account<'info, Automation>,

    /// CHECK: validated against `automation.destination` via the constraint above.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ExecuteAutomation>) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );

    let automation = &mut ctx.accounts.automation;
    require!(!automation.executed, SotamaError::AlreadyExecuted);

    let amount = automation.amount_lamports;
    let from_info = automation.to_account_info();
    let dest_info = ctx.accounts.destination.to_account_info();

    let from_balance = from_info.lamports();
    let dest_balance = dest_info.lamports();
    **from_info.try_borrow_mut_lamports()? = from_balance
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    **dest_info.try_borrow_mut_lamports()? = dest_balance
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    automation.executed = true;
    automation.executed_at = Clock::get()?.unix_timestamp;

    emit!(AutomationExecuted {
        pubkey: automation.key(),
        destination: automation.destination,
        amount_lamports: amount,
    });

    Ok(())
}
