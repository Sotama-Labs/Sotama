use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::events::{AutomationExecuted, AutomationFinished};
use crate::state::{ActionSpec, Automation, Config};

/// Execute a `TransferSol` automation. The keeper signer is verified
/// against `Config.keeper`; the destination is verified against the
/// stored ActionSpec.
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
    )]
    pub automation: Account<'info, Automation>,

    /// CHECK: validated against `automation.action.destination` below.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ExecuteAutomation>) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );

    let automation = &mut ctx.accounts.automation;
    let now = Clock::get()?.unix_timestamp;
    automation.check_can_fire(now)?;

    let (destination_key, amount) = match &automation.action {
        ActionSpec::TransferSol {
            destination,
            amount,
        } => (*destination, *amount),
        _ => return err!(SotamaError::ActionMismatch),
    };
    require_keys_eq!(
        destination_key,
        ctx.accounts.destination.key(),
        SotamaError::WrongDestination
    );

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

    automation.advance(now);

    emit!(AutomationExecuted {
        pubkey: automation.key(),
        action_kind: automation.action.kind_byte(),
        amount,
        executions: automation.executions,
        finished: automation.finished,
    });

    if automation.finished {
        emit!(AutomationFinished {
            automation: automation.key(),
            reason: 0, // fired_terminal
        });
    }

    Ok(())
}

