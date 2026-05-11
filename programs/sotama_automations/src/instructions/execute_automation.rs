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
    let auto_key = automation.key();

    if automation.handle_until_expiry(auto_key, now)? {
        return Ok(());
    }

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
    let new_from_balance = from_balance
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    // A SOL-action PDA that's still alive (not at end-of-life) must
    // remain rent-exempt or the runtime rejects the tx at finalization,
    // wedging the rule (#12 — "zombie PDA"). Allow the explicit
    // "drain-to-zero" case where the user closes the rule out by
    // setting `amount` to the entire PDA balance; otherwise require
    // the post-transfer balance stays above rent_min.
    let rent_min = Rent::get()?.minimum_balance(from_info.data_len());
    require!(
        new_from_balance == 0 || new_from_balance >= rent_min,
        SotamaError::TransferLeavesPdaBelowRent
    );
    **from_info.try_borrow_mut_lamports()? = new_from_balance;
    **dest_info.try_borrow_mut_lamports()? = dest_balance
        .checked_add(amount)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    automation.advance(now);

    emit!(AutomationExecuted {
        automation: automation.key(),
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

