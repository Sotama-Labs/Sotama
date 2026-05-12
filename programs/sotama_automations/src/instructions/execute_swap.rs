use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token_interface::{
    self, Mint as TokenInterfaceMint, TokenInterface, TransferChecked,
};

use crate::errors::SotamaError;
use crate::events::{AutomationExecuted, AutomationFilled, AutomationFinished};
use crate::jupiter::{self, SwapAccountMeta};
use crate::state::{ActionSpec, Automation, Config};

/// Decode the (mint, owner, amount) triple from the raw bytes of any
/// SPL token account — legacy SPL or Token-2022. Both layouts place the
/// base account fields at the same byte offsets:
///   bytes  0-31: mint pubkey
///   bytes 32-63: owner pubkey
///   bytes 64-71: amount (u64, little-endian)
/// Token-2022 appends an extension area after byte 165, but we only
/// read the base fields. The `spl_token_2022` SDK's
/// `unpack_account_state` would also work but borrows the slice as
/// `&[u8]` with associated lifetimes that make it awkward to use
/// inside a scoped block; raw decoding keeps the borrow window
/// minimal so `invoke_signed` can re-borrow afterward.
fn decode_token_account_base(data: &[u8]) -> Result<(Pubkey, Pubkey, u64)> {
    // 165 is the legacy SPL account length; 72 is enough for just the
    // base fields. We require at least 72 — anything shorter is not a
    // valid token account.
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

/// Execute a Jupiter v6 swap using funds held in the Automation PDA's
/// input ATA. The keeper queries Jupiter's `/build` API off-chain to
/// get a `swapInstruction`, then relays its accounts + data through
/// this handler, which `invoke_signed`s the inner ix with the PDA as
/// signer.
///
/// Trust split: the keeper is already a configured signer in
/// `Config.keeper`, so trusting it to format the Jupiter ix correctly
/// is consistent with the rest of the keeper's authority. The
/// on-chain validations below prevent the keeper from redirecting
/// funds — the inner program must be Jupiter, the input/output mints
/// must match the locked-in action, and the output ATA must end with
/// at least `min_amount_out` more tokens than it started.
///
/// Argument layout:
///   • `inner_ix_data` — the Jupiter ix's `data` bytes verbatim
///     (base64-decoded from the API response)
///   • `inner_ix_account_metas` — parallel to `remaining_accounts`,
///     describes each account's signer/writable role
///   • `input_ata_index` / `output_ata_index` — indices into
///     `remaining_accounts` for the PDA's input ATA and the
///     destination's output ATA, so we can mint-check them on-chain
#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [
            b"automation",
            automation.owner.as_ref(),
            &automation.nonce.to_le_bytes(),
        ],
        bump = automation.bump,
    )]
    pub automation: Account<'info, Automation>,

    /// CHECK: address-checked against the canonical Jupiter v6 program ID.
    #[account(address = jupiter::program::ID)]
    pub jupiter_program: UncheckedAccount<'info>,

    /// Treasury's ATA for the swap's output mint. Receives the protocol
    /// swap fee (`received * config.swap_fee_bps / 10_000`) after the
    /// slippage check passes. The handler verifies mint = output_mint
    /// and owner = config.treasury directly against the account data —
    /// no `InterfaceAccount<TokenAccount>` constraint here because
    /// Anchor needs the output mint to be known at IDL-derive time and
    /// it lives in the action spec.
    /// CHECK: validated in the handler.
    #[account(mut)]
    pub treasury_output_ata: UncheckedAccount<'info>,

    /// Output mint of the swap. Passed as an account here (rather than
    /// pulled from `action`) because `transfer_checked` requires the
    /// mint account in the CPI, AND we need its `decimals` value. The
    /// handler validates the key against `ActionSpec::Swap.output_mint`
    /// so the caller can't sneak in the wrong mint. Polymorphic over
    /// legacy SPL vs Token-2022.
    pub output_mint: InterfaceAccount<'info, TokenInterfaceMint>,

    /// Token program for the output mint. Accepts either legacy SPL or
    /// Token-2022 at runtime; Anchor validates it matches the mint's
    /// owning program.
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
    inner_ix_data: Vec<u8>,
    inner_ix_account_metas: Vec<SwapAccountMeta>,
    input_ata_index: u8,
    output_ata_index: u8,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );

    let automation = &mut ctx.accounts.automation;
    let now = Clock::get()?.unix_timestamp;
    let auto_key = automation.key();

    if automation.handle_until_expiry(auto_key, now)? {
        return Ok(());
    }

    automation.check_can_fire(now)?;

    let (
        input_mint,
        output_mint,
        destination,
        amount_in,
        min_amount_out,
        linked_downstream,
        link_fee_deposit,
    ) = match &automation.action {
        ActionSpec::Swap {
            input_mint,
            output_mint,
            destination,
            amount_in,
            min_amount_out,
            linked_downstream,
            link_fee_deposit,
            consume_upstream_output: _,
        } => (
            *input_mint,
            *output_mint,
            *destination,
            *amount_in,
            *min_amount_out,
            *linked_downstream,
            *link_fee_deposit,
        ),
        _ => return err!(SotamaError::ActionMismatch),
    };

    // Sanity-check the relay payload. The remaining_accounts layout is:
    //   [0..inner_ix_account_metas.len()) — the Jupiter inner ix accounts
    //   [inner_count]                     — (optional) linked downstream PDA
    let remaining = ctx.remaining_accounts;
    let inner_count = inner_ix_account_metas.len();
    let expected_total = inner_count + if linked_downstream.is_some() { 1 } else { 0 };
    require!(
        remaining.len() == expected_total,
        SotamaError::BadSwapAccounts
    );
    require!(
        (input_ata_index as usize) < inner_count
            && (output_ata_index as usize) < inner_count,
        SotamaError::BadSwapAccounts
    );
    require!(
        link_fee_deposit <= crate::state::MAX_LINK_FEE_LAMPORTS,
        SotamaError::LinkFeeCapExceeded
    );

    // Mint + ownership checks on the source/destination ATAs. We can't
    // use Anchor's typed `Account<TokenAccount>` because they live in
    // remaining_accounts, but `TokenAccount::try_deserialize` works
    // against an UncheckedAccount.
    //
    // CRITICAL: every `try_borrow_data()` call returns a `Ref<>` whose
    // lifetime is bound to the slice reference taken from it. If we
    // don't scope these blocks, the Ref guards stay alive through the
    // function body and the subsequent `invoke_signed` fails with
    // `AccountBorrowFailed` when Jupiter tries to access these same
    // accounts. The prior `let _ = x;` lines DID NOT release the
    // borrows — `&[u8]` is Copy so the binding is never moved out, and
    // temporary lifetime extension kept the underlying Ref alive.
    let input_ata_info = &remaining[input_ata_index as usize];
    let output_ata_info = &remaining[output_ata_index as usize];

    // Validate that the on-stack `output_mint` account matches the
    // action's recorded output mint — the keeper supplies this account
    // but on-chain decides whether to trust it. Without this check, a
    // misformed (or hostile) keeper-built ix could pass a different
    // mint whose decimals mismatch the actual output ATA, leading
    // `transfer_checked` to fail with `MintMismatch` (safe failure) or
    // worse, allow a tax-extension fee miscalculation.
    require_keys_eq!(
        ctx.accounts.output_mint.key(),
        output_mint,
        SotamaError::WrongOutputMint
    );

    // Snapshot balances so we can verify the post-CPI increase and
    // compute the actual fill amounts for the AutomationFilled event.
    // (Jupiter's inner ix has its own slippage guard via
    // `otherAmountThreshold`, but we enforce ours independently —
    // the keeper might pass a lax threshold.)
    //
    // We decode only the base SPL token-account fields (mint, owner,
    // amount) so the same path handles both legacy SPL and Token-2022
    // ATAs without an explicit type branch. Token-2022's extension
    // area sits past byte 165 and is irrelevant to these checks.
    let input_before: u64;
    let output_before: u64;
    {
        let input_data = input_ata_info.try_borrow_data()?;
        let (mint_k, owner_k, amount) = decode_token_account_base(&input_data)?;
        require_keys_eq!(mint_k, input_mint, SotamaError::WrongInputMint);
        require_keys_eq!(owner_k, automation.key(), SotamaError::BadSwapAccounts);
        input_before = amount;
        // input_data Ref drops here at scope end — Jupiter is free to
        // borrow the same account during invoke_signed.
    }
    {
        let output_data = output_ata_info.try_borrow_data()?;
        let (mint_k, owner_k, amount) = decode_token_account_base(&output_data)?;
        require_keys_eq!(mint_k, output_mint, SotamaError::WrongOutputMint);
        require_keys_eq!(owner_k, destination, SotamaError::WrongDestination);
        output_before = amount;
        // output_data Ref drops here at scope end.
    }

    // Reconstruct the AccountMeta list the inner ix expects. Only the
    // first `inner_count` remaining accounts feed Jupiter; the optional
    // linked-downstream PDA, if present, is index `inner_count`.
    let metas: Vec<AccountMeta> = remaining
        .iter()
        .take(inner_count)
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

    // Sign as the automation PDA. The Jupiter route ix expects the
    // PDA in the `taker` (user transfer authority) slot — the keeper
    // must have built the /build request with `taker = automation
    // PDA pubkey`.
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

    // Pass only the inner accounts to invoke_signed; the optional
    // downstream PDA is borrowed below for the auto-deposit transfer
    // and shouldn't be exposed to Jupiter's ix.
    let inner_remaining = &remaining[..inner_count];
    invoke_signed(&ix, inner_remaining, signer_seeds)?;

    // Verify the swap actually delivered ≥ min_amount_out. For
    // Token-2022 mints with a `TransferFee` extension, `received` is
    // the NET amount that lands in the destination ATA after the
    // mint's transfer fee was withheld by `transfer_checked` inside
    // the Jupiter route's leaf transfer — this is the right number
    // to compare against `min_amount_out` because that's what the
    // user actually got. The keeper is expected to factor expected
    // transfer-fee deductions into the slippage budget when it picks
    // min_amount_out (Jupiter's quote returns the post-fee out_amount).
    let received = {
        let post_data = output_ata_info.try_borrow_data()?;
        let (_, _, post_amount) = decode_token_account_base(&post_data)?;
        post_amount
            .checked_sub(output_before)
            .ok_or(error!(SotamaError::SlippageExceeded))?
    };
    require!(received >= min_amount_out, SotamaError::SlippageExceeded);

    // Cap how much input the Jupiter CPI was allowed to consume. The
    // PDA's input ATA is pre-funded with `amount_in × total_fires` at
    // create time so it can cover every fire over the rule's lifetime
    // (see create_automation_swap). Without this cap the keeper could
    // build a Jupiter route that consumes the entire remaining balance
    // in one fire — output still lands at the user's destination, but
    // the rule's TWAP/DCA semantics collapse (N scheduled fires
    // squashed into one), and any aggregated MEV from a single large
    // swap accrues to a sandwich bot instead of being amortized across
    // separate fires. Re-read the input ATA here, before fee math
    // touches the output ATA, so we fail fast on overspend.
    let input_consumed = {
        let post_input_data = input_ata_info.try_borrow_data()?;
        let (_, _, post_input_amount) = decode_token_account_base(&post_input_data)?;
        input_before.saturating_sub(post_input_amount)
    };
    require!(
        input_consumed <= amount_in,
        SotamaError::InputConsumedExceedsAmountIn
    );

    // Protocol swap fee on the delivered amount. `swap_fee_bps / 10_000`
    // of `received` is transferred from the output ATA to the treasury's
    // output ATA. PDA signs the SPL transfer. Treasury ATA mint+owner
    // are validated against `output_mint` and `Config.treasury` so a
    // misconfigured keeper can't redirect the fee to a wallet it
    // controls. When `swap_fee_bps == 0` we still touch the treasury
    // ATA cheaply via the mint/owner read but skip the transfer.
    //
    // Token-2022 nuance: if the output mint carries a TransferFee
    // extension, `transfer_checked` will withhold mint-level fees from
    // this debit too — so the treasury receives slightly less than
    // `swap_fee`. That's a known property of fee-extension mints and
    // matches what users observe for any transfer; the protocol fee
    // is still proportional to what the user received in net terms.
    let swap_fee_bps = ctx.accounts.config.swap_fee_bps;
    let treasury_pubkey = ctx.accounts.config.treasury;
    let swap_fee: u64 = ((received as u128).saturating_mul(swap_fee_bps as u128) / 10_000) as u64;
    {
        let treasury_ata_info = ctx.accounts.treasury_output_ata.to_account_info();
        let treasury_data = treasury_ata_info.try_borrow_data()?;
        let (mint_k, owner_k, _) = decode_token_account_base(&treasury_data)?;
        require_keys_eq!(mint_k, output_mint, SotamaError::BadTreasuryOutput);
        require_keys_eq!(owner_k, treasury_pubkey, SotamaError::BadTreasuryOwner);
    }
    if swap_fee > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: output_ata_info.to_account_info(),
                    mint: ctx.accounts.output_mint.to_account_info(),
                    to: ctx.accounts.treasury_output_ata.to_account_info(),
                    authority: automation.to_account_info(),
                },
                signer_seeds,
            ),
            swap_fee,
            ctx.accounts.output_mint.decimals,
        )?;
    }
    // `received` for the user-facing fill is what stays in the output
    // ATA after the protocol fee debit. Anything downstream (linked
    // rule, fill event) sees the net amount.
    let received = received.saturating_sub(swap_fee);

    // Emit the fill event so the keeper can capture the effective fill
    // price for downstream PriceRelativeToFill triggers.
    // `input_consumed` was computed and checked above.
    emit!(AutomationFilled {
        automation: auto_key,
        input_amount: input_consumed,
        output_amount: received,
        fill_slot: Clock::get()?.slot,
    });

    // Linked-rule auto-deposit: if this swap has a linked downstream
    // automation, transfer link_fee_deposit lamports from this PDA to
    // the downstream PDA so its next fire is prepaid. The downstream
    // PDA is the LAST remaining account.
    if let Some(downstream_key) = linked_downstream {
        let downstream_info = &remaining[inner_count];
        require_keys_eq!(
            *downstream_info.key,
            downstream_key,
            SotamaError::DownstreamMismatch
        );

        // Anchor uses two-account direct lamport math here rather than
        // a system_program::transfer CPI, because the source is a
        // PDA-owned data account (Anchor's `Automation`), and CPIs
        // signed by the runtime can't move lamports out of an
        // owned-data account. Direct mutation works because both
        // accounts are owned by this program.
        let auto_info = automation.to_account_info();
        let pre_lamports = auto_info.lamports();
        let rent_exempt = Rent::get()?.minimum_balance(auto_info.data_len());
        let after_debit = pre_lamports
            .checked_sub(link_fee_deposit)
            .ok_or(error!(SotamaError::LinkedFeePoolBelowRent))?;
        require!(
            after_debit >= rent_exempt,
            SotamaError::LinkedFeePoolBelowRent
        );
        **auto_info.try_borrow_mut_lamports()? = after_debit;
        **downstream_info.try_borrow_mut_lamports()? = downstream_info
            .lamports()
            .checked_add(link_fee_deposit)
            .ok_or(error!(SotamaError::DepositOverflow))?;
    }

    automation.advance(now);

    emit!(AutomationExecuted {
        automation: automation.key(),
        action_kind: automation.action.kind_byte(),
        amount: received,
        executions: automation.executions,
        finished: automation.finished,
    });

    if automation.finished {
        emit!(AutomationFinished {
            automation: automation.key(),
            reason: 0, // fired_terminal
        });
    }

    Ok(())
}
