use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use solana_stake_interface as stake;

use crate::errors::SotamaError;
use crate::events::AutomationExecuted;
use crate::instructions::execute_automation::enforce_time_window;
use crate::state::{ActionSpec, Automation, Config};

/// Re-delegate the stake account's full balance to its current vote
/// account. The automation PDA must be the stake's `staker` authority —
/// the user authorizes this once before creating the automation.
///
/// Compounds accrued rewards back into active stake (since
/// `DelegateStake` re-stakes the full lamport balance, including
/// rewards earned since the last delegation).
#[derive(Accounts)]
pub struct ExecuteRestake<'info> {
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

    /// CHECK: validated against `automation.action.vote_account`.
    pub vote_account: UncheckedAccount<'info>,

    /// CHECK: clock sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::clock::ID)]
    pub clock_sysvar: UncheckedAccount<'info>,

    /// CHECK: stake_history sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::stake_history::ID)]
    pub stake_history_sysvar: UncheckedAccount<'info>,

    /// CHECK: legacy stake config — required by DelegateStake.
    #[account(address = stake::config::ID)]
    pub stake_config: UncheckedAccount<'info>,

    /// CHECK: stake program ID.
    #[account(address = stake::program::ID)]
    pub stake_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<ExecuteRestake>) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );

    let automation = &mut ctx.accounts.automation;
    let now = Clock::get()?.unix_timestamp;
    automation.check_can_fire(now)?;

    let (stake_account_key, vote_account_key) = match &automation.action {
        ActionSpec::StakeRestake {
            stake_account,
            vote_account,
        } => (*stake_account, *vote_account),
        _ => return err!(SotamaError::ActionMismatch),
    };
    require_keys_eq!(
        stake_account_key,
        ctx.accounts.stake_account.key(),
        SotamaError::WrongStakeAccount
    );
    require_keys_eq!(
        vote_account_key,
        ctx.accounts.vote_account.key(),
        SotamaError::WrongVoteAccount
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

    let ix = stake::instruction::delegate_stake(
        &ctx.accounts.stake_account.key(),
        &automation.key(),
        &ctx.accounts.vote_account.key(),
    );

    invoke_signed(
        &ix,
        &[
            ctx.accounts.stake_account.to_account_info(),
            ctx.accounts.vote_account.to_account_info(),
            ctx.accounts.clock_sysvar.to_account_info(),
            ctx.accounts.stake_history_sysvar.to_account_info(),
            ctx.accounts.stake_config.to_account_info(),
            automation.to_account_info(),
            ctx.accounts.stake_program.to_account_info(),
        ],
        signer_seeds,
    )?;

    let staked_lamports = ctx.accounts.stake_account.lamports();
    automation.advance(now);

    emit!(AutomationExecuted {
        pubkey: automation.key(),
        action_kind: automation.action.kind_byte(),
        amount: staked_lamports,
        executions: automation.executions,
        finished: automation.finished,
    });

    Ok(())
}
