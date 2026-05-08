use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token::TokenAccount;

use crate::errors::SotamaError;
use crate::events::AutomationExecuted;
use crate::instructions::execute_automation::enforce_time_window;
use crate::jupiter::{self, SwapAccountMeta};
use crate::state::{ActionSpec, Automation, Config};

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
}

pub fn handler<'info>(
    ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
    inner_ix_data: Vec<u8>,
    inner_ix_account_metas: Vec<SwapAccountMeta>,
    input_ata_index: u8,
    output_ata_index: u8,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );

    let automation = &mut ctx.accounts.automation;
    let now = Clock::get()?.unix_timestamp;
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

    enforce_time_window(&automation.trigger, automation.executed_at)?;

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
    let input_ata_info = &remaining[input_ata_index as usize];
    let output_ata_info = &remaining[output_ata_index as usize];

    let mut input_data: &[u8] = &input_ata_info.try_borrow_data()?;
    let input_ata = TokenAccount::try_deserialize(&mut input_data)?;
    require_keys_eq!(input_ata.mint, input_mint, SotamaError::WrongInputMint);
    require_keys_eq!(
        input_ata.owner,
        automation.key(),
        SotamaError::BadSwapAccounts
    );

    let mut output_data: &[u8] = &output_ata_info.try_borrow_data()?;
    let output_ata = TokenAccount::try_deserialize(&mut output_data)?;
    require_keys_eq!(output_ata.mint, output_mint, SotamaError::WrongOutputMint);
    require_keys_eq!(output_ata.owner, destination, SotamaError::WrongDestination);

    // Snapshot the output balance so we can verify the post-CPI
    // increase satisfies `min_amount_out`. (Jupiter's inner ix has its
    // own slippage guard via `otherAmountThreshold`, but we enforce
    // ours independently — the keeper might pass a lax threshold.)
    let output_before = output_ata.amount;
    // Explicitly release the borrowed data so we can re-borrow the
    // output ATA after the CPI. Borsh deserialization above held
    // references into try_borrow_data's RefCell guard.
    let _ = input_data;
    let _ = output_data;

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

    // Verify the swap actually delivered ≥ min_amount_out.
    let mut post_data: &[u8] = &output_ata_info.try_borrow_data()?;
    let post_output = TokenAccount::try_deserialize(&mut post_data)?;
    let received = post_output
        .amount
        .checked_sub(output_before)
        .ok_or(error!(SotamaError::SlippageExceeded))?;
    require!(received >= min_amount_out, SotamaError::SlippageExceeded);
    let _ = amount_in; // amount_in is informational at this layer; Jupiter's ix bytes carry it

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
        pubkey: automation.key(),
        action_kind: automation.action.kind_byte(),
        amount: received,
        executions: automation.executions,
        finished: automation.finished,
    });

    Ok(())
}
