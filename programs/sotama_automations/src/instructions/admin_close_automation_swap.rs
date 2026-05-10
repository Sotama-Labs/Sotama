use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{ActionSpec, Automation, Config};

/// Admin-driven close for `Swap` automations during wind-down.
/// Same shape as `admin_close_automation_spl` but operates on the
/// swap's input ATA. The output ATA belongs to `destination` (a user
/// wallet) and is not touched here — its tokens were already credited
/// at swap-fire time.
///
/// Refund routing (same split as the SPL variant):
///   1. Swap input deposit → owner's input ATA (owner gets unspent
///      input mint back).
///   2. PDA's input ATA closes → treasury (ATA rent).
///   3. PDA's rent_min → treasury (Anchor `close = treasury`).
#[derive(Accounts)]
pub struct AdminCloseAutomationSwap<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: address-checked against `automation.owner`.
    #[account(
        mut,
        address = automation.owner @ SotamaError::WrongDestination,
    )]
    pub owner: AccountInfo<'info>,

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
        has_one = admin,
    )]
    pub config: Account<'info, Config>,

    /// CHECK: address-checked against `config.treasury`.
    #[account(
        mut,
        address = config.treasury @ SotamaError::WrongTreasury,
    )]
    pub treasury: AccountInfo<'info>,

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

pub fn handler(ctx: Context<AdminCloseAutomationSwap>) -> Result<()> {
    require!(ctx.accounts.config.shutdown, SotamaError::NotShutdown);

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

    let token_amount = ctx.accounts.automation_input_ata.amount;
    if token_amount > 0 {
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
            token_amount,
        )?;
    }

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.automation_input_ata.to_account_info(),
            destination: ctx.accounts.treasury.to_account_info(),
            authority: automation.to_account_info(),
        },
        signer_seeds,
    ))?;

    let pda_lamports = automation.to_account_info().lamports();

    emit!(AutomationFinished {
        automation: automation.key(),
        reason: 1, // closed
    });

    emit!(AutomationClosed {
        pubkey: automation.key(),
        owner: ctx.accounts.owner.key(),
        refund_lamports: 0,
        fee_lamports: pda_lamports,
    });

    Ok(())
}
