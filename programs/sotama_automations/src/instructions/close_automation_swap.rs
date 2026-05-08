use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::AutomationClosed;
use crate::state::{ActionSpec, Automation};

/// Close an automation whose action is `Swap`. Drains the PDA's input
/// ATA (which holds `amount_in × max_runs` of `input_mint` from create
/// time, possibly partially consumed by past fires) back to the owner,
/// closes the input ATA, then closes the automation account itself.
///
/// Mirrors `close_automation_spl` but for the Jupiter-relay action's
/// input deposit. The swap's destination side (`destination_output_ata`)
/// is owned by `destination`, not by the PDA, so it doesn't need
/// reclaim — its tokens were already credited at swap-fire time.
#[derive(Accounts)]
pub struct CloseAutomationSwap<'info> {
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

    pub input_mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = owner_input_ata.mint == input_mint.key() @ SotamaError::WrongInputMint,
        constraint = owner_input_ata.owner == owner.key() @ SotamaError::WrongDestination,
    )]
    pub owner_input_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = automation_input_ata.mint == input_mint.key() @ SotamaError::WrongInputMint,
        constraint = automation_input_ata.owner == automation.key() @ SotamaError::BadSwapAccounts,
    )]
    pub automation_input_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<CloseAutomationSwap>) -> Result<()> {
    let automation = &ctx.accounts.automation;

    let expected_input_mint = match &automation.action {
        ActionSpec::Swap { input_mint, .. } => *input_mint,
        _ => return err!(SotamaError::ActionMismatch),
    };
    require_keys_eq!(
        expected_input_mint,
        ctx.accounts.input_mint.key(),
        SotamaError::WrongInputMint
    );

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

    let remaining = ctx.accounts.automation_input_ata.amount;
    if remaining > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SplTransfer {
                    from: ctx.accounts.automation_input_ata.to_account_info(),
                    to: ctx.accounts.owner_input_ata.to_account_info(),
                    authority: automation.to_account_info(),
                },
                signer_seeds,
            ),
            remaining,
        )?;
    }

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.automation_input_ata.to_account_info(),
            destination: ctx.accounts.owner.to_account_info(),
            authority: automation.to_account_info(),
        },
        signer_seeds,
    ))?;

    let refund = automation.to_account_info().lamports();
    emit!(AutomationClosed {
        pubkey: automation.key(),
        owner: ctx.accounts.owner.key(),
        refund_lamports: refund,
    });

    Ok(())
}
