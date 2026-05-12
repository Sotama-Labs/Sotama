use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{
    self, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::errors::SotamaError;
use crate::events::AutomationCreated;
use crate::state::{
    assert_no_transfer_hook, compute_time_fee, ActionSpec, Automation, Cadence, Config,
    TriggerSpec,
};

/// Create an automation whose action is `Swap`. The owner deposits
/// `amount_in × max_runs` of `input_mint` from their ATA into the
/// Automation PDA's ATA for the input mint. At execute time the keeper
/// fetches a fresh Jupiter `/build` quote and relays the resulting
/// inner ix through `execute_swap`, which CPIs into Jupiter v6 with
/// the PDA as signer.
///
/// Both ATAs (the PDA's input ATA, paying-for here; the destination's
/// output ATA, used at execute time) must already exist — the client
/// wraps idempotent `createAssociatedTokenAccount` ixs into the same
/// transaction.
#[derive(Accounts)]
pub struct CreateAutomationSwap<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = owner,
        space = 8 + Automation::INIT_SPACE,
        seeds = [
            b"automation",
            owner.key().as_ref(),
            &config.automation_count.to_le_bytes(),
        ],
        bump,
    )]
    pub automation: Account<'info, Automation>,

    pub input_mint: InterfaceAccount<'info, Mint>,

    /// Owner's ATA for `input_mint`. Source of the deposit.
    #[account(
        mut,
        constraint = owner_input_ata.mint == input_mint.key() @ SotamaError::WrongInputMint,
        constraint = owner_input_ata.owner == owner.key() @ SotamaError::BadSwapAccounts,
    )]
    pub owner_input_ata: InterfaceAccount<'info, TokenAccount>,

    /// Automation PDA's ATA for `input_mint`. Pre-created by the client.
    #[account(
        mut,
        constraint = automation_input_ata.mint == input_mint.key() @ SotamaError::WrongInputMint,
        constraint = automation_input_ata.owner == automation.key() @ SotamaError::BadSwapAccounts,
    )]
    pub automation_input_ata: InterfaceAccount<'info, TokenAccount>,

    /// Recipient of the upfront time fee. Address-checked against
    /// `config.keeper`.
    /// CHECK: address-checked.
    #[account(
        mut,
        address = config.keeper @ SotamaError::UnauthorizedKeeper,
    )]
    pub keeper: AccountInfo<'info>,

    /// Token program for `input_mint`. `Interface<TokenInterface>`
    /// accepts either the legacy SPL Token program or Token-2022, and
    /// Anchor validates at runtime that the program ID matches the
    /// mint's owner program — so callers can't sneak a Token-2022 mint
    /// through with the legacy program id.
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateAutomationSwap>,
    trigger: TriggerSpec,
    action: ActionSpec,
    cadence: Cadence,
    min_interval_secs: u32,
    enable_fee_topup: bool,
) -> Result<()> {
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    let (input_mint, amount_in) = match &action {
        ActionSpec::Swap {
            input_mint,
            amount_in,
            ..
        } => (*input_mint, *amount_in),
        _ => return err!(SotamaError::ActionMismatch),
    };
    require!(amount_in > 0, SotamaError::DepositTooSmall);
    require_keys_eq!(
        input_mint,
        ctx.accounts.input_mint.key(),
        SotamaError::WrongInputMint
    );
    // Reject Token-2022 mints carrying the `TransferHook` extension.
    // Hook code is mint-authority-supplied and runs via CPI on every
    // transfer; we can't bound its behavior, so we refuse to relay
    // ATAs whose every transfer could trigger arbitrary execution.
    // Legacy SPL mints and Token-2022 mints without the hook
    // extension pass cleanly. Transfer-fee, confidential-transfer,
    // and the other non-hook extensions are all OK because
    // `transfer_checked` honours them deterministically and our
    // post-CPI ATA-delta check absorbs any fee deduction.
    assert_no_transfer_hook(&ctx.accounts.input_mint)?;
    trigger.validate()?;
    cadence.validate()?;

    // Swap actions consume `amount_in` per fire. The PDA must hold
    // enough at create time to cover every fire — once-per-fire
    // top-ups aren't a UX we ship in the MVP. So:
    //   • Once       → deposit = amount_in
    //   • Repeat N   → deposit = amount_in × N
    //   • Until      → unbounded, can't pre-fund. Reject.
    let total_fires: u64 = match &cadence {
        Cadence::Once => 1,
        Cadence::Repeat { total } => *total as u64,
        Cadence::Until { .. } => return err!(SotamaError::SwapUntilNotSupported),
    };
    let total_deposit = amount_in
        .checked_mul(total_fires)
        .ok_or(error!(SotamaError::DepositOverflow))?;

    let trigger_kind_byte = trigger.kind_byte();
    let trigger_pubkey = trigger.primary_pubkey();
    let action_kind_byte = action.kind_byte();
    let cadence_kind_byte = cadence.kind_byte();

    let nonce = ctx.accounts.config.automation_count;
    let now = Clock::get()?.unix_timestamp;

    if let Cadence::Until { unix_deadline } = &cadence {
        require!(*unix_deadline > now, SotamaError::BadCadence);
    }

    let time_fee = compute_time_fee(
        &cadence,
        now,
        ctx.accounts.config.time_fee_lamports_per_day,
    );

    let automation = &mut ctx.accounts.automation;
    automation.owner = ctx.accounts.owner.key();
    automation.nonce = nonce;
    automation.trigger = trigger;
    automation.action = action;
    automation.cadence = cadence;
    automation.executions = 0;
    automation.min_interval_secs = min_interval_secs;
    automation.finished = false;
    automation.created_at = now;
    automation.executed_at = 0;
    automation.bump = ctx.bumps.automation;
    // Opt-in for `execute_fee_topup`. Default false — only swap rules
    // can opt in (the other create_automation_* handlers leave this at
    // its zero-init default of false). A leaked keeper key thus can't
    // route an SPL-only PDA's holdings through Jupiter.
    automation.fee_topup_enabled = enable_fee_topup;
    automation.bridge_enabled = false;

    // Pull `total_deposit = amount_in × total_fires` from owner's ATA
    // into the PDA's input ATA. Each fire then spends `amount_in` of it.
    // `transfer_checked` is required for Token-2022 (which honours the
    // transfer-fee extension on this call) and accepted by legacy SPL.
    // The runtime-supplied mint decimals are validated against the
    // mint account passed here, so a misformatted ix can't silently
    // transfer the wrong number of base units.
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            TransferChecked {
                from: ctx.accounts.owner_input_ata.to_account_info(),
                mint: ctx.accounts.input_mint.to_account_info(),
                to: ctx.accounts.automation_input_ata.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        total_deposit,
        ctx.accounts.input_mint.decimals,
    )?;

    // Upfront time fee → keeper.
    if time_fee > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.keeper.to_account_info(),
                },
            ),
            time_fee,
        )?;
    }

    ctx.accounts.config.automation_count = nonce
        .checked_add(1)
        .ok_or(error!(SotamaError::DepositTooSmall))?;

    emit!(AutomationCreated {
        automation: automation.key(),
        owner: automation.owner,
        nonce,
        trigger_kind: trigger_kind_byte,
        action_kind: action_kind_byte,
        trigger_pubkey,
        cadence_kind: cadence_kind_byte,
    });

    Ok(())
}
