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

/// Create a chain-linked Swap automation.
///
/// Same shape as `create_automation_swap` but takes an explicit
/// `seed_amount` (deposit at create time) instead of computing it from
/// `amount_in × total_fires`. For chained rules:
///   * **Head rule**: pass `seed_amount = amount_in` — covers cycle 1.
///   * **Downstream rule**: pass `seed_amount = 0` — the PDA's input ATA
///     stays empty until upstream `Swap.destination` routing fills it
///     from the prior rule's swap output.
///
/// Allows `Cadence::Until` (rejected by `create_automation_swap` because
/// the deposit can't pre-cover unbounded fires) — chained rules
/// self-feed via the next-cycle output flow, so deposit doesn't scale
/// with fire count. The same is true of high-`total` `Repeat` cadences:
/// a `Repeat { total: 1_000_000 }` is reasonable for a perpetual arb
/// loop with `seed_amount = amount_in`.
///
/// Trust split: identical to `create_automation_swap` — the keeper still
/// signs `execute_swap`, the on-chain handler still validates mints and
/// the inner Jupiter program ID. The `seed_amount` parameter only
/// affects the create-time owner→PDA deposit transfer, never the
/// fire-time spend (which is always `amount_in`).
#[derive(Accounts)]
pub struct CreateAutomationSwapLinked<'info> {
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

    /// Owner's ATA for `input_mint`. Source of the optional seed
    /// transfer. Must exist even when `seed_amount = 0` because Anchor
    /// reads it as a typed account; client always idempotent-creates it.
    #[account(
        mut,
        constraint = owner_input_ata.mint == input_mint.key() @ SotamaError::WrongInputMint,
        constraint = owner_input_ata.owner == owner.key() @ SotamaError::BadSwapAccounts,
    )]
    pub owner_input_ata: InterfaceAccount<'info, TokenAccount>,

    /// Automation PDA's ATA for `input_mint`. Pre-created idempotently
    /// by the client. Receives the optional seed transfer at create
    /// time and is the destination ATA the upstream rule's
    /// `Swap.destination` should point to (so its output mint = this
    /// rule's input mint).
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

    /// Token program for `input_mint`. Polymorphic interface that
    /// accepts legacy SPL or Token-2022 at runtime; Anchor checks the
    /// program ID matches the mint's owning program.
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateAutomationSwapLinked>,
    trigger: TriggerSpec,
    action: ActionSpec,
    cadence: Cadence,
    min_interval_secs: u32,
    enable_fee_topup: bool,
    seed_amount: u64,
    bridge_enabled: bool,
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
    // Refuse mints with the Token-2022 TransferHook extension — see
    // the matching call in `create_automation_swap` for rationale.
    // Note: we only check the INPUT mint here; the output mint isn't
    // an account on this ix. The downstream rule in a chain has its
    // own input_mint check at create time, so a chain whose output
    // mint has a transfer hook can't even be wired (the next rule's
    // create would reject the same mint as its input).
    assert_no_transfer_hook(&ctx.accounts.input_mint)?;
    trigger.validate()?;
    cadence.validate()?;

    // Linked rules accept any cadence. `Until` would normally be
    // rejected by `create_automation_swap` because the upfront deposit
    // can't pre-cover unbounded fires, but here the deposit is decoupled
    // (chain self-feeds) so the rejection doesn't apply. Still validate
    // that the deadline is in the future.
    if let Cadence::Until { unix_deadline } = &cadence {
        let now = Clock::get()?.unix_timestamp;
        require!(*unix_deadline > now, SotamaError::BadCadence);
    }

    let trigger_kind_byte = trigger.kind_byte();
    let trigger_pubkey = trigger.primary_pubkey();
    let action_kind_byte = action.kind_byte();
    let cadence_kind_byte = cadence.kind_byte();

    let nonce = ctx.accounts.config.automation_count;
    let now = Clock::get()?.unix_timestamp;

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
    // Linked rules typically opt into `execute_fee_topup` so the keeper
    // can auto-sell PDA tokens to refill its operating SOL budget when
    // the chain has been firing for a while.
    automation.fee_topup_enabled = enable_fee_topup;
    automation.bridge_enabled = bridge_enabled;

    // Optional seed transfer. `seed_amount = 0` is valid and means
    // "downstream rule — wait for upstream output to fill the input
    // ATA." `seed_amount > 0` deposits exactly that many input units
    // (typically `amount_in` for the chain head, covering cycle 1).
    // `transfer_checked` is mandatory for Token-2022 paths and works
    // identically on legacy SPL.
    if seed_amount > 0 {
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
            seed_amount,
            ctx.accounts.input_mint.decimals,
        )?;
    }

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
