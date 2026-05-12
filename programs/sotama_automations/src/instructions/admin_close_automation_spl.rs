use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

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
///   3. PDA's above-rent SOL deposit → owner. Any SOL the owner
///      directly system-transferred into the PDA (e.g. to seed a
///      keeper-fee buffer) is theirs regardless of who triggered the
///      close. Mirrors the user-driven close path (#9).
///   4. Anchor's `close = treasury` sweeps the PDA's own rent_min →
///      treasury.
///
/// Net result: tokens + above-rent SOL to owner, ATA rent + PDA rent
/// to treasury. Owner's ATA must exist beforehand — the wind-down
/// script prepends
/// `createAssociatedTokenAccountIdempotentInstruction(admin, owner, mint)`
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

    // Boxed to keep try_accounts' BPF stack under 4096 bytes.
    // InterfaceAccount is ~64B larger than Account, and three of them
    // push this struct's generated frame over the limit. Same pattern
    // as AdminCloseAutomationSwap / CloseAutomationSwap.
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// Owner's ATA for `mint`. Must be pre-created by the caller —
    /// admin pays the rent for an idempotent ATA-create when the
    /// owner has never received this mint.
    #[account(
        mut,
        constraint = owner_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = owner_ata.owner == owner.key() @ SotamaError::WrongDestination,
    )]
    pub owner_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// PDA's ATA for `mint`. Drained then closed by this ix.
    #[account(
        mut,
        constraint = automation_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = automation_ata.owner == automation.key() @ SotamaError::BadSplAccounts,
    )]
    pub automation_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
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

    // Step 1: SPL deposit → owner's ATA (PDA signs). transfer_checked
    // works for both legacy SPL and Token-2022.
    let token_amount = ctx.accounts.automation_ata.amount;
    if token_amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.automation_ata.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.owner_ata.to_account_info(),
                    authority: automation.to_account_info(),
                },
                signer_seeds,
            ),
            token_amount,
            ctx.accounts.mint.decimals,
        )?;
    }

    // Step 2: Close PDA's ATA → ATA rent to treasury.
    token_interface::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.automation_ata.to_account_info(),
            destination: ctx.accounts.treasury.to_account_info(),
            authority: automation.to_account_info(),
        },
        signer_seeds,
    ))?;

    // Step 3: Refund any above-rent SOL the owner deposited into the
    // PDA. SPL rules don't auto-accumulate `link_fee_deposit` the way
    // chained Swap rules do, but the owner can still system-transfer
    // SOL into the PDA (e.g. to seed a keeper-fee buffer). On
    // admin-driven wind-down, those deposits belong to the user — same
    // policy as the user-driven close (#9). PDA rent_min still flows
    // to treasury via Anchor's `close = treasury` below.
    let auto_info = automation.to_account_info();
    let pda_balance = auto_info.lamports();
    let rent_exempt = Rent::get()?.minimum_balance(auto_info.data_len());
    let deposit_refund = pda_balance.saturating_sub(rent_exempt);
    if deposit_refund > 0 {
        **auto_info.try_borrow_mut_lamports()? = pda_balance
            .checked_sub(deposit_refund)
            .ok_or(error!(SotamaError::FeeTooLarge))?;
        let owner_info = ctx.accounts.owner.to_account_info();
        **owner_info.try_borrow_mut_lamports()? = owner_info
            .lamports()
            .checked_add(deposit_refund)
            .ok_or(error!(SotamaError::FeeTooLarge))?;
    }

    // Step 4: Anchor's `close = treasury` will run after this returns,
    // sending the PDA's rent_min to treasury. We capture the lamport
    // figures for the event before that runs.
    let pda_lamports = auto_info.lamports();

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
        fee_lamports: pda_lamports,
    });

    Ok(())
}
