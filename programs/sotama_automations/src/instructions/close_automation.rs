use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{Automation, Config};

/// Close a `TransferSol` automation. Lamport split on close:
///   * Unfired SOL deposit (PDA balance above rent-exempt) → owner.
///   * Rent-exempt portion of the PDA → `Config.treasury`.
///
/// The rent IS the close fee — there's no separate configurable
/// close-fee field anymore. Owner only gets back what they would have
/// transferred out if the rule had fired (or stays with what already
/// fired if the rule partially executed).
///
/// Anchor's `close = treasury` constraint sweeps whatever remains in
/// the PDA's lamports to treasury after the manual debit below. By
/// pre-debiting the above-rent excess to owner first, the `close`
/// sweep ends up moving only the rent.
#[derive(Accounts)]
pub struct CloseAutomation<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

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
    )]
    pub config: Account<'info, Config>,

    /// CHECK: address-checked against `config.treasury`. Receives the
    /// rent-exempt portion via Anchor's `close = treasury` sweep.
    #[account(
        mut,
        address = config.treasury @ SotamaError::WrongTreasury,
    )]
    pub treasury: AccountInfo<'info>,
}

pub fn handler(ctx: Context<CloseAutomation>) -> Result<()> {
    let auto_info = ctx.accounts.automation.to_account_info();
    let pda_balance = auto_info.lamports();
    let rent_exempt = Rent::get()?.minimum_balance(auto_info.data_len());
    // Anything above rent-exempt is the user's unfired deposit. For an
    // already-fired Once or fully-fired Repeat, this will be zero.
    let deposit_refund = pda_balance.saturating_sub(rent_exempt);

    if deposit_refund > 0 {
        // Direct lamport math is correct here: both accounts are owned
        // by this program (PDA via `init`) and we're crediting a system
        // account (owner) which always accepts credits.
        **auto_info.try_borrow_mut_lamports()? = pda_balance
            .checked_sub(deposit_refund)
            .ok_or(error!(SotamaError::FeeTooLarge))?;
        let owner_info = ctx.accounts.owner.to_account_info();
        **owner_info.try_borrow_mut_lamports()? = owner_info
            .lamports()
            .checked_add(deposit_refund)
            .ok_or(error!(SotamaError::FeeTooLarge))?;
    }

    // Whatever is left in the PDA at this point is the rent-exempt
    // amount; Anchor's `close = treasury` sweeps it on handler return.
    let fee_lamports = auto_info.lamports();
    let automation = &ctx.accounts.automation;

    if !automation.finished {
        emit!(AutomationFinished {
            automation: automation.key(),
            reason: 1, // closed
        });
    }

    emit!(AutomationClosed {
        automation: automation.key(),
        owner: ctx.accounts.owner.key(),
        refund_lamports: deposit_refund,
        fee_lamports,
    });

    Ok(())
}
