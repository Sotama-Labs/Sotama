use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::errors::SotamaError;
use crate::jupiter::{self, SwapAccountMeta};
use crate::state::{ActionSpec, Automation, Config};

/// See `execute_swap::decode_token_account_base` for the layout
/// rationale. Duplicated here so the bridge handler doesn't have to
/// pull the helper out into a shared module (and so the compiler
/// inlines it cheaply for the slippage check on the hot path).
fn decode_base(data: &[u8]) -> Result<(Pubkey, Pubkey, u64)> {
    if data.len() < 165 {
        return err!(SotamaError::BadSwapAccounts);
    }
    let mint = Pubkey::try_from(&data[0..32]).map_err(|_| error!(SotamaError::BadSwapAccounts))?;
    let owner =
        Pubkey::try_from(&data[32..64]).map_err(|_| error!(SotamaError::BadSwapAccounts))?;
    let amount = u64::from_le_bytes(
        data[64..72]
            .try_into()
            .map_err(|_| error!(SotamaError::BadSwapAccounts))?,
    );
    Ok((mint, owner, amount))
}

/// Keeper-driven, per-PDA-authorized Jupiter swap that converts any
/// non-input-mint token holdings of the PDA into its expected input
/// mint. Used by the chain bridge dispatcher when adjacent rules in a
/// chain don't share mints — Rule N's swap output lands in Rule N+1's
/// PDA in the wrong mint, and `execute_bridge` converts it within
/// Rule N+1's PDA.
///
/// Trust split mirrors `execute_fee_topup`:
///   * The keeper signs as the PDA via `invoke_signed`.
///   * The output ATA's owner MUST be the automation PDA (funds stay
///     within this rule's wallet).
///   * The output ATA's mint MUST equal the automation's `Swap.input_mint`
///     (funds land in the canonical input ATA the rule expects to
///     consume on its next fire).
///   * `min_amount_out` is enforced post-CPI on the output ATA delta
///     so a misrouted Jupiter quote can't burn user funds.
///   * Per-PDA opt-in via `automation.bridge_enabled`.
///
/// Not gated by `check_can_fire`. Doesn't increment `executions` or
/// `executed_at`.
#[derive(Accounts)]
pub struct ExecuteBridge<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [
            b"automation",
            automation.owner.as_ref(),
            &automation.nonce.to_le_bytes(),
        ],
        bump = automation.bump,
    )]
    pub automation: Account<'info, Automation>,

    /// CHECK: address-checked against jupiter::program::ID.
    #[account(address = jupiter::program::ID)]
    pub jupiter_program: UncheckedAccount<'info>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ExecuteBridge<'info>>,
    inner_ix_data: Vec<u8>,
    inner_ix_account_metas: Vec<SwapAccountMeta>,
    output_ata_index: u8,
    min_amount_out: u64,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );
    // Per-PDA opt-in. Without this gate, a leaked keeper signing key
    // could swap a PDA's holdings to whatever mint it likes (within
    // the trust constraints below). Only rules whose owner explicitly
    // opted into bridge dispatch at create time pass.
    require!(
        ctx.accounts.automation.bridge_enabled,
        SotamaError::BridgeNotEnabled
    );

    // Pull the expected input mint off the automation's swap action so
    // the on-chain check is canonical (action is the source of truth).
    // A non-Swap action with bridge_enabled=true is a misconfig and
    // should fail closed — `bridge_enabled` is only set on Swap rules
    // by `create_automation_swap_linked`, so this branch should be
    // unreachable in practice.
    let expected_mint = match &ctx.accounts.automation.action {
        ActionSpec::Swap { input_mint, .. } => *input_mint,
        _ => return err!(SotamaError::BridgeNotEnabled),
    };

    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() == inner_ix_account_metas.len(),
        SotamaError::BadSwapAccounts
    );
    require!(
        (output_ata_index as usize) < remaining.len(),
        SotamaError::BadSwapAccounts
    );

    // Validate the destination ATA: mint == expected_mint, owner == PDA.
    // Read amount before the CPI so we can enforce the slippage guard
    // on the post-CPI delta. Base-field decode handles legacy SPL and
    // Token-2022 ATAs uniformly.
    let output_ata_info = &remaining[output_ata_index as usize];
    let output_before;
    {
        let data_buf = output_ata_info.try_borrow_data()?;
        let (mint_k, owner_k, amount) = decode_base(&data_buf)?;
        require_keys_eq!(mint_k, expected_mint, SotamaError::BadBridgeOutput);
        require_keys_eq!(
            owner_k,
            ctx.accounts.automation.key(),
            SotamaError::BadBridgeOwner
        );
        output_before = amount;
    } // borrow released here before invoke

    // Reconstruct the inner-ix AccountMeta list, then invoke as the
    // automation PDA so Jupiter can move the source tokens out of the
    // PDA's ATAs into `expected_mint` (still owned by the PDA).
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .zip(inner_ix_account_metas.iter())
        .map(|(info, meta)| AccountMeta {
            pubkey: *info.key,
            is_signer: meta.is_signer,
            is_writable: meta.is_writable,
        })
        .collect();

    let ix = Instruction {
        program_id: ctx.accounts.jupiter_program.key(),
        accounts: metas,
        data: inner_ix_data,
    };

    let automation = &ctx.accounts.automation;
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

    invoke_signed(&ix, remaining, signer_seeds)?;

    // Slippage guard on the output ATA delta. Re-decode the ATA's
    // base fields post-CPI and require received >= min_amount_out —
    // protects users from a misrouted or low-output Jupiter quote.
    let received = {
        let post_data = output_ata_info.try_borrow_data()?;
        let (_, _, post_amount) = decode_base(&post_data)?;
        post_amount
            .checked_sub(output_before)
            .ok_or(error!(SotamaError::BridgeSlippageExceeded))?
    };
    require!(received >= min_amount_out, SotamaError::BridgeSlippageExceeded);

    Ok(())
}
