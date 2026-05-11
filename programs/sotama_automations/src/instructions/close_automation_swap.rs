use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{ActionSpec, Automation, Config};

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
    ctx: Context<'_, '_, '_, 'info, CloseAutomationSwap<'info>>,
) -> Result<()> {
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

    // Drain any non-input-mint token balances the PDA may hold (e.g.
    // dust from interrupted bridges, stale chain output that the keeper
    // didn't auto-bridge before close). Each pair is (pda_ata,
    // owner_ata) for the same mint. Validate strictly so this close ix
    // can't double as an arbitrary token-transfer primitive.
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
                destination: ctx.accounts.owner.to_account_info(),
                authority: automation.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // PDA's remaining lamports are pure rent at this point — input
    // ATA's deposit went to owner via token::transfer, input ATA's rent
    // went to owner via token::close_account, and the optional
    // remaining-account dust pairs followed the same flow. Anchor's
    // `close = treasury` sweeps the PDA rent on handler return.
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
