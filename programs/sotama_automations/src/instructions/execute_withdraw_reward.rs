use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use solana_stake_interface as stake;

use crate::errors::SotamaError;
use crate::events::AutomationExecuted;
use crate::instructions::execute_automation::enforce_time_window;
use crate::state::{ActionSpec, Automation, Config};

/// Withdraw `amount` lamports from the stake account → destination
/// wallet. The automation PDA must be the stake's `withdraw` authority.
///
/// The keeper computes the reward portion off-chain
/// (current_balance − delegation.stake − rent_exempt) and passes it as
/// `amount`. The stake program enforces:
///   • Withdraw cannot exceed lamports − delegation.stake −
///     rent_exempt_minimum (fails the CPI if so).
///   • The signer matches the stake account's withdraw authority
///     (otherwise CPI fails).
#[derive(Accounts)]
pub struct ExecuteWithdrawReward<'info> {
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

    /// CHECK: validated against `automation.action.stake_account`.
    #[account(mut)]
    pub stake_account: UncheckedAccount<'info>,

    /// CHECK: validated against `automation.action.destination`.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,

    /// CHECK: clock sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,

    /// CHECK: stake_history sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: UncheckedAccount<'info>,

    /// CHECK: stake program ID.
    #[account(address = stake::program::ID)]
    pub stake_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ExecuteWithdrawReward>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );
    require!(amount > 0, SotamaError::DepositTooSmall);

    let automation = &mut ctx.accounts.automation;
    require!(!automation.executed, SotamaError::AlreadyExecuted);

    let (stake_account_key, destination_key) = match &automation.action {
        ActionSpec::StakeWithdrawReward {
            stake_account,
            destination,
        } => (*stake_account, *destination),
        _ => return err!(SotamaError::ActionMismatch),
    };
    require_keys_eq!(
        stake_account_key,
        ctx.accounts.stake_account.key(),
        SotamaError::WrongStakeAccount
    );
    require_keys_eq!(
        destination_key,
        ctx.accounts.destination.key(),
        SotamaError::WrongDestination
    );

    enforce_time_window(&automation.trigger, automation.executed_at)?;

    let owner_key = automation.owner;
    let nonce_bytes = automation.nonce.to_le_bytes();
    let bump = [automation.bump];
    let pda_seeds: &[&[u8]] = &[
        b"automation",
        owner_key.as_ref(),
        nonce_bytes.as_ref(),
        bump.as_ref(),
    ];
    let signer_seeds: &[&[&[u8]]] = &[pda_seeds];

    let ix = stake::instruction::withdraw(
        &ctx.accounts.stake_account.key(),
        &automation.key(),
        &ctx.accounts.destination.key(),
        amount,
        None,
    );

    invoke_signed(
        &ix,
        &[
            ctx.accounts.stake_account.to_account_info(),
            ctx.accounts.destination.to_account_info(),
            ctx.accounts.clock_sysvar.to_account_info(),
            ctx.accounts.stake_history_sysvar.to_account_info(),
            automation.to_account_info(),
            ctx.accounts.stake_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    automation.executed = true;
    automation.executed_at = Clock::get()?.unix_timestamp;

    emit!(AutomationExecuted {
        pubkey: automation.key(),
        action_kind: automation.action.kind_byte(),
        amount,
    });

    Ok(())
}
