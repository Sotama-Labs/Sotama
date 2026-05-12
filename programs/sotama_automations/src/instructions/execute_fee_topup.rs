use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::errors::SotamaError;
use crate::jupiter::{self, SwapAccountMeta};
use crate::state::{Automation, Config};

/// Polymorphic legacy-SPL / Token-2022 base-field decode. See
/// `execute_swap::decode_token_account_base` for the layout rationale.
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
/// somewhere it doesn't already control AND from extracting value at
/// a poor exchange rate:
///
///   * The output ATA's mint MUST be wrapped SOL (`So111...11112`).
///   * The output ATA's owner MUST be the keeper signer (NOT the
///     destination, NOT the PDA — the keeper, who pays tx fees).
///   * The relayed inner ix MUST target the canonical Jupiter v6 ID.
///   * The keeper's wSOL ATA MUST be credited at least `min_amount_out`
///     lamports of wSOL between pre- and post-CPI snapshots. Without
///     this guard, a compromised keeper key could swap the PDA's
///     tokens at an arbitrarily bad rate (sandwich, low-liquidity
///     pool, fee-on-transfer router) and skim the difference — the
///     other checks would still pass because the output mint+owner
///     match. Mirrors the `SlippageExceeded` guard in `execute_swap`
///     and `execute_bridge`.
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
    // could drain ANY user PDA's token holdings via a Jupiter route
    // back to a wSOL ATA the keeper owns. Only swap rules whose owner
    // explicitly opted into auto-fee-management at create time pass.
    require!(
        ctx.accounts.automation.fee_topup_enabled,
        SotamaError::FeeTopupNotEnabled
    );
    // Defense in depth: don't allow fee topup on a finished rule. A
    // terminal Repeat (executions == total) can still hold token
    // residuals — dust from rounding on past fires or stranded chain
    // output that didn't bridge cleanly. Without this gate, a leaked
    // keeper key could continue swapping those residuals to its wSOL
    // ATA after the rule's user-facing lifetime ended. The owner is
    // expected to call `close_automation_swap` (which routes residuals
    // back to them) once the rule is finished; this require! makes
    // that the only path.
    require!(
        !ctx.accounts.automation.finished,
        SotamaError::AutomationFinished
    );
    // Even with the opt-in, the keeper must promise a non-zero output
    // floor — `min_amount_out == 0` would be functionally equivalent
    // to no slippage check and defeat the guard's purpose.
    require!(min_amount_out > 0, SotamaError::SlippageExceeded);

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
    // keeper signer. This is the only ownership-shape constraint
    // distinguishing execute_fee_topup from execute_swap — output must
    // come back to the keeper, not to a user wallet, so the keeper can
    // convert it to operating SOL off-band. Snapshot the pre-CPI
    // balance here so the post-CPI slippage check is provable. wSOL
    // (`So111…1112`) is always a legacy SPL mint, so the base-field
    // decode is fine here — but using the same polymorphic helper
    // means execute_fee_topup keeps working if the keeper ever
    // switches to a Token-2022 wrapped-SOL equivalent.
    let keeper_wsol_ata_info = &remaining[keeper_wsol_ata_index as usize];
    let wsol_before: u64 = {
        let data_buf = keeper_wsol_ata_info.try_borrow_data()?;
        let (mint_k, owner_k, amount) = decode_base(&data_buf)?;
        require_keys_eq!(
            mint_k,
            anchor_spl::token::spl_token::native_mint::ID,
            SotamaError::BadFeeTopupOutput
        );
        require_keys_eq!(owner_k, ctx.accounts.keeper.key(), SotamaError::BadFeeTopupOwner);
        amount
    };

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

    // Post-CPI slippage check. Re-decode the keeper's wSOL ATA base
    // fields (the CPI may have rewritten its data via the token
    // program) and assert the credited amount cleared the floor the
    // keeper committed to at submit time. `checked_sub` catches the
    // pathological case where the CPI somehow decreased the balance
    // (e.g. a malformed route that debits the keeper instead).
    let received = {
        let post_data = keeper_wsol_ata_info.try_borrow_data()?;
        let (_, _, post_amount) = decode_base(&post_data)?;
        post_amount
            .checked_sub(wsol_before)
            .ok_or(error!(SotamaError::SlippageExceeded))?
    };
    require!(received >= min_amount_out, SotamaError::SlippageExceeded);

    Ok(())
}
