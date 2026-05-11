use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{ActionSpec, Automation, Config};

/// Close an automation whose action is `TransferSpl`. Drains the
/// PDA's ATA balance back to the owner's ATA, closes that ATA (rent
/// → owner), then closes the automation account itself (rent →
/// treasury).
///
/// Refund path (in order):
///   1. token::transfer  automation_ata.amount → owner_ata  (deposit)
///   2. token::close      automation_ata        → owner     (ATA rent)
///   3. close = treasury automation PDA         → treasury  (PDA rent — the close fee)
#[derive(Accounts)]
pub struct CloseAutomationSpl<'info> {
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

    // The PDA itself closes via Anchor's `close = treasury` constraint
    // on handler return — its lamports are pure rent at this point
    // (the token deposit and ATA rent were already moved above), so
    // treasury receives just the rent.
    let fee_lamports = automation.to_account_info().lamports();

    if !automation.finished {
        emit!(AutomationFinished {
            automation: automation.key(),
            reason: 1, // closed
        });
    }

    emit!(AutomationClosed {
        automation: automation.key(),
        owner: ctx.accounts.owner.key(),
        refund_lamports: 0,
        fee_lamports,
    });

    Ok(())
}
