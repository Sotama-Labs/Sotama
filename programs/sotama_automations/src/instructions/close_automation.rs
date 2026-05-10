use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{Automation, Config};

/// Close an automation whose action is `TransferSol`. Anchor sweeps the
/// PDA's lamports to the owner via `close = owner`. Before that sweep,
/// we divert `Config.close_fee_lamports` (capped to "above rent-exempt"
/// excess) to `Config.treasury`. Owner gets the rest. Action types that
/// also hold an SPL/swap deposit go through `close_automation_spl` or
/// `close_automation_swap` instead.
#[derive(Accounts)]
pub struct CloseAutomation<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
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
    )]
    pub config: Account<'info, Config>,

    /// CHECK: address-checked against `config.treasury`. Receives the
    /// close-fee lamports; if `config.close_fee_lamports == 0` or the
    /// PDA has no excess above rent-min, no transfer occurs and this
    /// account is read-only in effect.
    #[account(
        mut,
        address = config.treasury @ SotamaError::WrongTreasury,
    )]
    pub treasury: AccountInfo<'info>,
}

pub fn handler(ctx: Context<CloseAutomation>) -> Result<()> {
    let fee_lamports = deduct_close_fee(
        &ctx.accounts.automation.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        ctx.accounts.config.close_fee_lamports,
    )?;

    let automation = &ctx.accounts.automation;
    let refund = automation.to_account_info().lamports();

    emit!(AutomationFinished {
        automation: automation.key(),
        reason: 1, // closed
    });

    emit!(AutomationClosed {
        pubkey: automation.key(),
        owner: ctx.accounts.owner.key(),
        refund_lamports: refund,
        fee_lamports,
    });

    Ok(())
}

/// Move `requested` lamports (capped to "PDA balance minus rent-exempt
/// minimum for an Automation account") from the automation PDA to the
/// treasury. Returns the actual lamports transferred (may be less than
/// `requested` on freshly-created rules with no excess deposit).
///
/// Lamport-direct manipulation is safe here because both accounts are
/// owned by this program (the PDA via `init` at create time, the
/// treasury is a system account whose lamports we're crediting — the
/// runtime allows credits to any account regardless of owner).
pub(crate) fn deduct_close_fee<'info>(
    automation: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
    requested: u64,
) -> Result<u64> {
    if requested == 0 {
        return Ok(0);
    }
    let rent_min = Rent::get()?.minimum_balance(8 + Automation::INIT_SPACE);
    let pda_balance = automation.lamports();
    let max_fee = pda_balance.saturating_sub(rent_min);
    let actual_fee = requested.min(max_fee);
    if actual_fee == 0 {
        return Ok(0);
    }
    **automation.try_borrow_mut_lamports()? = pda_balance
        .checked_sub(actual_fee)
        .ok_or(error!(SotamaError::FeeTooLarge))?;
    let treasury_balance = treasury.lamports();
    **treasury.try_borrow_mut_lamports()? = treasury_balance
        .checked_add(actual_fee)
        .ok_or(error!(SotamaError::FeeTooLarge))?;
    Ok(actual_fee)
}
