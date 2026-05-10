use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{ActionSpec, Automation, Config};

/// Admin-driven close for `TransferSpl` automations during wind-down.
/// Only callable when `Config.shutdown == true`.
///
/// Refund routing:
///   1. SPL deposit (PDA's ATA balance) → owner's ATA via PDA-signed
///      `token::transfer`. Owner gets ALL their tokens back.
///   2. PDA's ATA closes with destination = `treasury` (ATA's rent
///      goes to treasury, not owner).
///   3. Anchor's `close = treasury` sweeps the PDA's own rent_min →
///      treasury.
///
/// Net result: tokens to user, all lamports (PDA rent + ATA rent) to
/// treasury. Owner's ATA must exist beforehand — the wind-down script
/// prepends `createAssociatedTokenAccountIdempotentInstruction(admin, owner, mint)`
/// so admin pays the rent for any owner ATAs that aren't initialized.
#[derive(Accounts)]
pub struct AdminCloseAutomationSpl<'info> {
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

    pub mint: Account<'info, Mint>,

    /// Owner's ATA for `mint`. Must be pre-created by the caller —
    /// admin pays the rent for an idempotent ATA-create when the
    /// owner has never received this mint.
    #[account(
        mut,
        constraint = owner_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = owner_ata.owner == owner.key() @ SotamaError::WrongDestination,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    /// PDA's ATA for `mint`. Drained then closed by this ix.
    #[account(
        mut,
        constraint = automation_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = automation_ata.owner == automation.key() @ SotamaError::BadSplAccounts,
    )]
    pub automation_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<AdminCloseAutomationSpl>) -> Result<()> {
    require!(ctx.accounts.config.shutdown, SotamaError::NotShutdown);

    let automation = &ctx.accounts.automation;
    let expected_mint = match &automation.action {
        ActionSpec::TransferSpl { mint, .. } => *mint,
        _ => return err!(SotamaError::ActionMismatch),
    };
    require_keys_eq!(expected_mint, ctx.accounts.mint.key(), SotamaError::WrongMint);

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

    // Step 1: SPL deposit → owner's ATA (PDA signs).
    let token_amount = ctx.accounts.automation_ata.amount;
    if token_amount > 0 {
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
            token_amount,
        )?;
    }

    // Step 2: Close PDA's ATA → ATA rent to treasury.
    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.automation_ata.to_account_info(),
            destination: ctx.accounts.treasury.to_account_info(),
            authority: automation.to_account_info(),
        },
        signer_seeds,
    ))?;

    // Step 3: Anchor's `close = treasury` will run after this returns,
    // sending the PDA's rent_min to treasury. We capture the lamport
    // figures for the event before that runs.
    let pda_lamports = automation.to_account_info().lamports();

    emit!(AutomationFinished {
        automation: automation.key(),
        reason: 1, // closed
    });

    emit!(AutomationClosed {
        pubkey: automation.key(),
        owner: ctx.accounts.owner.key(),
        // For admin-close events, refund_lamports is 0 (no SOL deposit
        // existed for this rule type) and fee_lamports captures the PDA
        // rent that flows to treasury. The SPL token amount lives in a
        // separate AutomationExecuted-style event in future versions if
        // needed; for now indexers can derive it from the token tx.
        refund_lamports: 0,
        fee_lamports: pda_lamports,
    });

    Ok(())
}
