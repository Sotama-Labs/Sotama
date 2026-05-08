use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::state::{Automation, Config, MAX_LINK_FEE_LAMPORTS};

/// Debit a small SOL fee from an automation PDA to the keeper signer.
/// Designed to be bundled by the keeper as a SEPARATE ix BEFORE any
/// `execute_*` ix when firing a linked rule, so the fee debit and the
/// downstream action atomically succeed or atomically fail together.
///
/// Trust split: the keeper is already a configured signer in
/// `Config.keeper`, so trusting it to bundle this fee debit is
/// consistent with the rest of the keeper's authority. The on-chain
/// invariants prevent the keeper from over-debiting:
///
///   * `fee_lamports ≤ MAX_LINK_FEE_LAMPORTS` (1 SOL / 1000 = ~$0.20
///     ceiling at typical SOL prices, much higher than the typical
///     5_000-lamport per-fire fee).
///   * Post-debit PDA balance ≥ rent-exempt minimum (the program
///     refuses to drain below rent, otherwise the account would be
///     auto-closed by the runtime).
///
/// Not gated by `check_can_fire` — fee debit is decoupled from firing
/// (the keeper can debit before any execute_* ix, regardless of the
/// rule's cadence/finished/min_interval state).
#[derive(Accounts)]
pub struct ExecuteLinkFeeDebit<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: arbitrary destination wallet for the fee. We require it
    /// matches `config.keeper` below, so it's effectively the keeper.
    /// Marked CHECK because we mutate its lamports directly.
    #[account(mut)]
    pub keeper_recipient: UncheckedAccount<'info>,

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
}

pub fn handler(ctx: Context<ExecuteLinkFeeDebit>, fee_lamports: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );
    require_keys_eq!(
        ctx.accounts.keeper_recipient.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );
    require!(
        fee_lamports <= MAX_LINK_FEE_LAMPORTS,
        SotamaError::LinkFeeCapExceeded
    );

    let auto_info = ctx.accounts.automation.to_account_info();
    let pre_lamports = auto_info.lamports();
    let rent_exempt = Rent::get()?.minimum_balance(auto_info.data_len());
    let after_debit = pre_lamports
        .checked_sub(fee_lamports)
        .ok_or(error!(SotamaError::LinkedFeePoolBelowRent))?;
    require!(
        after_debit >= rent_exempt,
        SotamaError::LinkedFeePoolBelowRent
    );

    let recipient_info = ctx.accounts.keeper_recipient.to_account_info();
    **auto_info.try_borrow_mut_lamports()? = after_debit;
    **recipient_info.try_borrow_mut_lamports()? = recipient_info
        .lamports()
        .checked_add(fee_lamports)
        .ok_or(error!(SotamaError::DepositOverflow))?;

    Ok(())
}
