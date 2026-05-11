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
/// Refund routing:
///   1. Swap input deposit → owner's input ATA (owner gets unspent
///      input mint back).
///   2. PDA's input ATA closes → treasury (ATA rent).
///   3. Optional dust ATAs the PDA still holds in non-input mints
///      (e.g. tokens stranded mid-bridge, stale chain output) — tokens
///      → owner, ATA rent → treasury. Pairs passed in
///      `remaining_accounts` as `[pda_ata, owner_ata]` for each dust
///      mint. Mirrors the user-driven `close_automation_swap` loop so
///      a force-close during shutdown doesn't trap chain-link tokens
///      under an orphaned PDA pubkey.
///   4. PDA's above-rent SOL deposit → owner. Linked-chain rules
///      accumulate `link_fee_deposit` lamports in the PDA from upstream
///      fires, and owners can directly top-up SOL; both belong to the
///      user, not the protocol, regardless of who triggered the close.
///   5. PDA's rent_min → treasury (Anchor `close = treasury`).
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

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, AdminCloseAutomationSwap<'info>>,
) -> Result<()> {
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

    // Drain any non-input-mint dust the PDA still holds — e.g. tokens
    // mid-bridge or stale chain-link output that the keeper didn't
    // sweep before shutdown. Without this loop, those tokens get
    // stranded under the PDA pubkey when Anchor's `close = treasury`
    // zeroes the Automation account: the ATAs survive but their
    // authority (the PDA) can no longer sign. Validate every pair
    // strictly so this ix can't double as an arbitrary token-transfer
    // primitive under admin authority.
    let input_mint_key = ctx.accounts.input_mint.key();
    let automation_key = ctx.accounts.automation.key();
    let owner_key_acct = ctx.accounts.owner.key();

    for chunk in ctx.remaining_accounts.chunks(2) {
        if chunk.len() != 2 {
            return err!(SotamaError::BadCloseAccounts);
        }
        let pda_ata_info = &chunk[0];
        let owner_ata_info = &chunk[1];
        let pda_ata: TokenAccount = TokenAccount::try_deserialize(
            &mut &pda_ata_info.try_borrow_data()?[..],
        )?;
        let owner_ata: TokenAccount = TokenAccount::try_deserialize(
            &mut &owner_ata_info.try_borrow_data()?[..],
        )?;
        require_keys_eq!(pda_ata.owner, automation_key, SotamaError::BadCloseAccounts);
        require_keys_eq!(owner_ata.owner, owner_key_acct, SotamaError::BadCloseAccounts);
        require_keys_eq!(pda_ata.mint, owner_ata.mint, SotamaError::BadCloseAccounts);
        require!(pda_ata.mint != input_mint_key, SotamaError::BadCloseAccounts);

        if pda_ata.amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    SplTransfer {
                        from: pda_ata_info.clone(),
                        to: owner_ata_info.clone(),
                        authority: automation.to_account_info(),
                    },
                    signer_seeds,
                ),
                pda_ata.amount,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: pda_ata_info.clone(),
                destination: ctx.accounts.treasury.to_account_info(),
                authority: automation.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // Refund any above-rent SOL deposit to the owner before Anchor's
    // `close = treasury` sweep. Mirrors the #9 fix on the user-driven
    // close path: a force-close triggered by admin during shutdown
    // shouldn't extract the owner's deposits — those belong to the
    // user regardless of who initiated the close. Linked-chain rules
    // accumulate `link_fee_deposit` lamports in the PDA from upstream
    // fires; owners may also have directly top-up'd SOL to refill the
    // keeper-fee buffer. Rent_min still flows to treasury (Anchor's
    // `close = treasury`) as the protocol close fee.
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
