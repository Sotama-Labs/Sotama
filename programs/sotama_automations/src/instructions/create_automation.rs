use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::SotamaError;
use crate::events::AutomationCreated;
use crate::state::{
    ActionSpec, Automation, Cadence, Config, TriggerSpec, MIN_AMOUNT_LAMPORTS,
};

/// Create an automation whose action is `TransferSol`. The deposit is
/// pulled from `owner` into the Automation PDA at create time and held
/// there until either `execute_automation` (transfers it to destination)
/// or `close_automation` (refunds the owner) is called.
#[derive(Accounts)]
pub struct CreateAutomation<'info> {
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

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateAutomation>,
    trigger: TriggerSpec,
    action: ActionSpec,
    cadence: Cadence,
    min_interval_secs: u32,
) -> Result<()> {
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    let amount = match &action {
        ActionSpec::TransferSol { amount, .. } => *amount,
        _ => return err!(SotamaError::ActionMismatch),
    };
    // Repeat/Until cadences will fire `executions` times against the same
    // PDA balance; the program only ever transfers the action's `amount`
    // out per fire, so the deposit must cover the worst-case sum. The UI
    // pre-multiplies, but we still gate on a per-fire minimum here.
    require!(amount >= MIN_AMOUNT_LAMPORTS, SotamaError::DepositTooSmall);
    trigger.validate()?;
    cadence.validate()?;

    let trigger_kind_byte = trigger.kind_byte();
    let trigger_pubkey = trigger.primary_pubkey();
    let action_kind_byte = action.kind_byte();
    let cadence_kind_byte = cadence.kind_byte();

    let nonce = ctx.accounts.config.automation_count;
    let now = Clock::get()?.unix_timestamp;

    // For Until cadences, reject deadlines that are already in the past
    // at create time. (Cadence::validate only checks the value is > 0.)
    if let Cadence::Until { unix_deadline } = &cadence {
        require!(*unix_deadline > now, SotamaError::BadCadence);
    }

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

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: automation.to_account_info(),
            },
        ),
        amount,
    )?;

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
