use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::TokenAccount;

use crate::errors::SotamaError;
use crate::jupiter::{self, SwapAccountMeta};
use crate::state::{Automation, Config};

/// Keeper-driven token-to-wSOL conversion that lands the proceeds in
/// the **keeper's** wSOL ATA. This is the auto-fee-management primitive:
/// when a rule's SOL fee buffer runs low, the keeper swaps a slice of
/// the PDA's token holdings (USDC, etc.) into wSOL on its own account,
/// then unwraps that wSOL → real SOL off-band to refill its operating
/// balance. From the user's perspective, the rule never needs a SOL
/// top-up — it pays its own fees from the assets it's transacting.
///
/// Trust split: same as `execute_swap` — the keeper is a configured
/// signer, so trusting it to format the inner Jupiter ix is fine. The
/// on-chain invariants prevent the keeper from redirecting funds to
/// somewhere it doesn't already control:
///
///   * The output ATA's mint MUST be wrapped SOL (`So111...11112`).
///   * The output ATA's owner MUST be the keeper signer (NOT the
///     destination, NOT the PDA — the keeper, who pays tx fees).
///   * The relayed inner ix MUST target the canonical Jupiter v6 ID.
///
/// Not gated by `check_can_fire` — fee topup is independent of firing
/// and runs as a periodic maintenance ix from the keeper. Doesn't
/// touch `executions` or `executed_at`.
#[derive(Accounts)]
pub struct ExecuteFeeTopup<'info> {
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
    ctx: Context<'_, '_, '_, 'info, ExecuteFeeTopup<'info>>,
    inner_ix_data: Vec<u8>,
    inner_ix_account_metas: Vec<SwapAccountMeta>,
    keeper_wsol_ata_index: u8,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );
    // Per-PDA opt-in. Without this gate, a leaked keeper signing key
    // could drain ANY user PDA's token holdings via a Jupiter route
    // back to a wSOL ATA the keeper owns. Only swap rules whose owner
    // explicitly opted into auto-fee-management at create time pass.
    require!(
        ctx.accounts.automation.fee_topup_enabled,
        SotamaError::FeeTopupNotEnabled
    );

    let remaining = ctx.remaining_accounts;
    require!(
        remaining.len() == inner_ix_account_metas.len(),
        SotamaError::BadSwapAccounts
    );
    require!(
        (keeper_wsol_ata_index as usize) < remaining.len(),
        SotamaError::BadSwapAccounts
    );

    // The keeper's wSOL ATA must have mint = native wSOL and owner =
    // keeper signer. This is the only constraint distinguishing
    // execute_fee_topup from execute_swap — output must come back to
    // the keeper, not to a user wallet, so the keeper can convert it
    // to operating SOL off-band.
    let keeper_wsol_ata_info = &remaining[keeper_wsol_ata_index as usize];
    let mut data_buf: &[u8] = &keeper_wsol_ata_info.try_borrow_data()?;
    let keeper_wsol_ata = TokenAccount::try_deserialize(&mut data_buf)?;
    require_keys_eq!(
        keeper_wsol_ata.mint,
        anchor_spl::token::spl_token::native_mint::ID,
        SotamaError::BadFeeTopupOutput
    );
    require_keys_eq!(
        keeper_wsol_ata.owner,
        ctx.accounts.keeper.key(),
        SotamaError::BadFeeTopupOwner
    );
    let _ = data_buf; // release borrow before invoke

    // Reconstruct the inner-ix AccountMeta list, then invoke as the
    // automation PDA so Jupiter can move the input tokens out of the
    // PDA's ATAs.
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

    Ok(())
}
