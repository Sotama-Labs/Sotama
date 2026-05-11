use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::AutomationCreated;
use crate::state::{compute_time_fee, ActionSpec, Automation, Cadence, Config, TriggerSpec};

/// Create an automation whose action is `TransferSpl`. The owner deposits
/// `amount` of `mint` from their ATA into the Automation PDA's ATA. The
/// PDA's ATA must be pre-created in the same client tx (via
/// `createAssociatedTokenAccountInstruction`) — Anchor's `init_if_needed`
/// is intentionally avoided to keep the program surface area small.
#[derive(Accounts)]
pub struct CreateAutomationSpl<'info> {
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

    pub mint: Account<'info, Mint>,

    /// Owner's ATA — must already hold `amount` tokens of `mint`.
    #[account(
        mut,
        constraint = owner_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = owner_ata.owner == owner.key() @ SotamaError::BadSplAccounts,
    )]
    pub owner_ata: Account<'info, TokenAccount>,

    /// Automation PDA's ATA — must be pre-created and owned by `automation`.
    #[account(
        mut,
        constraint = automation_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = automation_ata.owner == automation.key() @ SotamaError::BadSplAccounts,
    )]
    pub automation_ata: Account<'info, TokenAccount>,

    /// Recipient of the upfront time fee. Address-checked against
    /// `config.keeper`.
    /// CHECK: address-checked.
    #[account(
        mut,
        address = config.keeper @ SotamaError::UnauthorizedKeeper,
    )]
    pub keeper: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateAutomationSpl>,
    trigger: TriggerSpec,
    action: ActionSpec,
    cadence: Cadence,
    min_interval_secs: u32,
) -> Result<()> {
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    let (destination, mint, amount) = match &action {
        ActionSpec::TransferSpl {
            destination,
            mint,
            amount,
        } => (*destination, *mint, *amount),
        _ => return err!(SotamaError::ActionMismatch),
    };
    require!(amount > 0, SotamaError::DepositTooSmall);
    require_keys_eq!(mint, ctx.accounts.mint.key(), SotamaError::WrongMint);
    let _ = destination;
    trigger.validate()?;
    cadence.validate()?;

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

    // Pull SPL tokens from owner's ATA → automation's ATA.
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.owner_ata.to_account_info(),
                to: ctx.accounts.automation_ata.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
    )?;

    // Upfront time fee → keeper. See `compute_time_fee` and
    // `create_automation::handler` for the rationale.
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
