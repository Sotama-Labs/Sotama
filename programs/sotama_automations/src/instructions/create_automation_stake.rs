use anchor_lang::prelude::*;

use crate::errors::SotamaError;
use crate::events::AutomationCreated;
use crate::state::{ActionSpec, Automation, Cadence, Config, TriggerSpec};

/// Create an automation whose action is `StakeRestake` or
/// `StakeWithdrawReward`. No SOL or SPL deposit happens at create time —
/// the value lives on the user's stake account, which the user must
/// authorize separately so the automation PDA is its `staker`
/// (`StakeRestake`) or `withdrawer` (`StakeWithdrawReward`).
///
/// The owner pays only Anchor's account rent for the Automation PDA.
#[derive(Accounts)]
pub struct CreateAutomationStake<'info> {
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
    ctx: Context<CreateAutomationStake>,
    trigger: TriggerSpec,
    action: ActionSpec,
    cadence: Cadence,
    min_interval_secs: u32,
) -> Result<()> {
    match &action {
        ActionSpec::StakeRestake { .. } | ActionSpec::StakeWithdrawReward { .. } => {}
        _ => return err!(SotamaError::ActionMismatch),
    };
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

    ctx.accounts.config.automation_count = nonce
        .checked_add(1)
        .ok_or(error!(SotamaError::DepositTooSmall))?;

    emit!(AutomationCreated {
        pubkey: automation.key(),
        owner: automation.owner,
        nonce,
        trigger_kind: trigger_kind_byte,
        action_kind: action_kind_byte,
        trigger_pubkey,
        cadence_kind: cadence_kind_byte,
    });

    Ok(())
}
