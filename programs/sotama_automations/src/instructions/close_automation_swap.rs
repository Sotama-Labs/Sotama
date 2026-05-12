use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::SotamaError;
use crate::events::{AutomationClosed, AutomationFinished};
use crate::state::{ActionSpec, Automation, Config};

/// Decode (mint, owner, amount, decimals_if_legacy) from raw bytes.
/// For the dust loop we don't have separate mint accounts available
/// for legacy SPL paths (legacy mint accounts are 82 bytes and live at
/// a separate pubkey we can't synthesize), so we only use this helper
/// to read the ATA's owner/mint/amount triple.
fn decode_ata_base(data: &[u8]) -> Result<(Pubkey, Pubkey, u64)> {
    if data.len() < 165 {
        return err!(SotamaError::BadCloseAccounts);
    }
    let mint = Pubkey::try_from(&data[0..32]).map_err(|_| error!(SotamaError::BadCloseAccounts))?;
    let owner =
        Pubkey::try_from(&data[32..64]).map_err(|_| error!(SotamaError::BadCloseAccounts))?;
    let amount = u64::from_le_bytes(
        data[64..72]
            .try_into()
            .map_err(|_| error!(SotamaError::BadCloseAccounts))?,
    );
    Ok((mint, owner, amount))
}

/// Read just the `decimals` byte from a raw Mint account. Position 44
/// in both legacy SPL (`MINT_LAYOUT_DECIMALS_OFFSET = 44`) and
/// Token-2022 base layouts; extension area starts past byte 82. Used
/// in the dust loop where we want `transfer_checked` decimals without
/// the cost of full `InterfaceAccount<Mint>` deserialization for each
/// dust pair.
fn read_mint_decimals(data: &[u8]) -> Result<u8> {
    // Legacy SPL mint = 82 bytes. Token-2022 mint is ≥ 82 bytes with
    // optional extension area past 82.
    if data.len() < 82 {
        return err!(SotamaError::BadCloseMint);
    }
    Ok(data[44])
}

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

    // Boxed for the same stack-frame reason as in
    // `AdminCloseAutomationSwap` — InterfaceAccount is ~64 B larger
    // than Account and three of them push `try_accounts` past BPF's
    // 4096-byte stack budget. `Box` moves storage to the heap.
    pub input_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        constraint = owner_input_ata.mint == input_mint.key() @ SotamaError::WrongInputMint,
        constraint = owner_input_ata.owner == owner.key() @ SotamaError::WrongDestination,
    )]
    pub owner_input_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = automation_input_ata.mint == input_mint.key() @ SotamaError::WrongInputMint,
        constraint = automation_input_ata.owner == automation.key() @ SotamaError::BadSwapAccounts,
    )]
    pub automation_input_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
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
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.automation_input_ata.to_account_info(),
                    mint: ctx.accounts.input_mint.to_account_info(),
                    to: ctx.accounts.owner_input_ata.to_account_info(),
                    authority: automation.to_account_info(),
                },
                signer_seeds,
            ),
            remaining,
            ctx.accounts.input_mint.decimals,
        )?;
    }

    token_interface::close_account(CpiContext::new_with_signer(
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
    // didn't auto-bridge before close). Token-2022 support requires
    // `transfer_checked`, which needs the mint account in the CPI —
    // so the remaining-accounts layout for dust is now TRIPLES of
    // (pda_ata, owner_ata, mint) instead of the pre-migration pairs.
    // Validate strictly so this close ix can't double as an arbitrary
    // token-transfer primitive.
    let input_mint_key = ctx.accounts.input_mint.key();
    let automation_key = ctx.accounts.automation.key();
    let owner_key_acct = ctx.accounts.owner.key();

    for chunk in ctx.remaining_accounts.chunks(3) {
        if chunk.len() != 3 {
            return err!(SotamaError::BadCloseAccounts);
        }
        let pda_ata_info = &chunk[0];
        let owner_ata_info = &chunk[1];
        let mint_info = &chunk[2];
        let (pda_mint, pda_owner, pda_amount) =
            decode_ata_base(&pda_ata_info.try_borrow_data()?)?;
        let (owner_mint, owner_owner, _) =
            decode_ata_base(&owner_ata_info.try_borrow_data()?)?;
        require_keys_eq!(pda_owner, automation_key, SotamaError::BadCloseAccounts);
        require_keys_eq!(owner_owner, owner_key_acct, SotamaError::BadCloseAccounts);
        require_keys_eq!(pda_mint, owner_mint, SotamaError::BadCloseAccounts);
        require!(pda_mint != input_mint_key, SotamaError::BadCloseAccounts);
        // Pin the mint account to the mint pubkey from the ATAs so the
        // caller can't pass an unrelated mint that happens to share
        // decimals. transfer_checked would catch a decimals mismatch,
        // but the explicit equality check produces a clearer error.
        require_keys_eq!(*mint_info.key, pda_mint, SotamaError::BadCloseMint);
        let decimals = read_mint_decimals(&mint_info.try_borrow_data()?)?;

        if pda_amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: pda_ata_info.clone(),
                        mint: mint_info.clone(),
                        to: owner_ata_info.clone(),
                        authority: automation.to_account_info(),
                    },
                    signer_seeds,
                ),
                pda_amount,
                decimals,
            )?;
        }
        token_interface::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: pda_ata_info.clone(),
                destination: ctx.accounts.owner.to_account_info(),
                authority: automation.to_account_info(),
            },
            signer_seeds,
        ))?;
    }

    // Refund any above-rent SOL deposit to the owner before Anchor's
    // `close = treasury` sweeps the remainder. The PDA accumulates
    // lamports above rent in two paths:
    //   * Linked chains — every upstream `execute_swap` fire transfers
    //     `link_fee_deposit` lamports into the downstream PDA to prepay
    //     its keeper-fee debits. Unspent surplus at close time belongs
    //     to the user, not the protocol.
    //   * Direct top-ups — the owner can system-transfer SOL into the
    //     PDA at any time to refill its keeper-fee buffer.
    // Without this, both paths get seized by `close = treasury` on a
    // user-driven close. Mirror `close_automation`'s split: refund
    // excess to owner, leave rent for treasury.
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

    // Whatever is left in the PDA at this point is the rent-exempt
    // amount; Anchor's `close = treasury` sweeps it on handler return.
    let fee_lamports = auto_info.lamports();

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
