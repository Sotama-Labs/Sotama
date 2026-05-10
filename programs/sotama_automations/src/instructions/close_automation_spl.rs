use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::instructions::close_automation::deduct_close_fee;
use crate::state::{ActionSpec, Automation, Config};

/// Close an automation whose action is `TransferSpl`. Drains the
/// PDA's ATA balance back to the owner's ATA, closes that ATA (rent
/// → owner), then closes the automation account itself (rent +
/// remaining lamports → owner).
///
/// **Why a separate ix:** the v3 `close_automation` only refunds the
/// PDA's own lamports — the SPL deposit lives inside `automation_ata`,
/// which `close = owner` doesn't touch. Without this handler, owners
/// who cancel an SPL automation lose their deposit.
///
/// Refund path (in order):
///   1. token::transfer  automation_ata.amount → owner_ata
///   2. token::close      automation_ata        → owner (rent)
///   3. deduct fee        automation PDA        → treasury
///   4. close = owner     automation PDA        → owner (rent + leftover SOL)
///
/// The fee is taken in lamports (native SOL) from the PDA's "above
/// rent-min" excess, never from the SPL deposit. So a freshly-created
/// rule with no excess SOL pays no fee even when `close_fee_lamports`
/// is non-zero.
#[derive(Accounts)]
pub struct CloseAutomationSpl<'info> {
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

    /// CHECK: address-checked against `config.treasury`.
    #[account(
        mut,
        address = config.treasury @ SotamaError::WrongTreasury,
    )]
    pub treasury: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    /// Owner's ATA for `mint`. Idempotent-created by the client tx
    /// before this ix runs, so we can deposit the refund into it.
    #[account(
        mut,
        constraint = owner_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = owner_ata.owner == owner.key() @ SotamaError::WrongDestination,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    /// Automation PDA's ATA for `mint`. Closed by this ix after its
    /// balance is drained.
    #[account(
        mut,
        constraint = automation_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = automation_ata.owner == automation.key() @ SotamaError::BadSplAccounts,
    )]
    pub automation_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseAutomationSpl>) -> Result<()> {
    let automation = &ctx.accounts.automation;

    // Validate: action must be TransferSpl with this mint, OR the
    // mint passed is consistent with whatever SPL-side action was
    // configured. Reject if the action isn't SPL — those should go
    // through close_automation (SOL) or close_automation_swap.
    let expected_mint = match &automation.action {
        ActionSpec::TransferSpl { mint, .. } => *mint,
        _ => return err!(SotamaError::ActionMismatch),
    };
    require_keys_eq!(expected_mint, ctx.accounts.mint.key(), SotamaError::WrongMint);

    // Drain the PDA's ATA into the owner's ATA. Sign as the PDA.
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

    let remaining = ctx.accounts.automation_ata.amount;
    if remaining > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.automation_ata.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: automation.to_account_info(),
                },
                signer_seeds,
            ),
            remaining,
        )?;
    }

    // Close the now-empty automation ATA → rent refund to owner.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.automation_ata.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: automation.to_account_info(),
        },
        signer_seeds,
    ))?;

    // Charge protocol fee from PDA's above-rent-min lamports → treasury.
    let fee_lamports = deduct_close_fee(
        &automation.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        ctx.accounts.config.close_fee_lamports,
    )?;

    // The PDA itself closes via Anchor's `close = owner` constraint
    // after this handler returns — owner gets rent + any leftover
    // lamports (minus the fee already deducted).
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
