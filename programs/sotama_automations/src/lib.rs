use anchor_lang::prelude::*;

declare_id!("2gp9bMBEVpQp6Lyyg13Bw6XF9S9saAcm9C4XQ69T8ZqQ");

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;
use state::{ActionSpec, TriggerSpec};

#[program]
pub mod sotama_automations {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>, keeper: Pubkey) -> Result<()> {
        instructions::initialize_config::handler(ctx, keeper)
    }

    pub fn update_keeper(ctx: Context<UpdateKeeper>, new_keeper: Pubkey) -> Result<()> {
        instructions::update_keeper::handler(ctx, new_keeper)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, paused)
    }

    pub fn create_automation(
        ctx: Context<CreateAutomation>,
        trigger: TriggerSpec,
        action: ActionSpec,
    ) -> Result<()> {
        instructions::create_automation::handler(ctx, trigger, action)
    }

    pub fn create_automation_spl(
        ctx: Context<CreateAutomationSpl>,
        trigger: TriggerSpec,
        action: ActionSpec,
    ) -> Result<()> {
        instructions::create_automation_spl::handler(ctx, trigger, action)
    }

    pub fn create_automation_stake(
        ctx: Context<CreateAutomationStake>,
        trigger: TriggerSpec,
        action: ActionSpec,
    ) -> Result<()> {
        instructions::create_automation_stake::handler(ctx, trigger, action)
    }

    pub fn execute_automation(ctx: Context<ExecuteAutomation>) -> Result<()> {
        instructions::execute_automation::handler(ctx)
    }

    pub fn execute_automation_spl(ctx: Context<ExecuteAutomationSpl>) -> Result<()> {
        instructions::execute_automation_spl::handler(ctx)
    }

    pub fn execute_restake(ctx: Context<ExecuteRestake>) -> Result<()> {
        instructions::execute_restake::handler(ctx)
    }

    pub fn execute_withdraw_reward(
        ctx: Context<ExecuteWithdrawReward>,
        amount: u64,
    ) -> Result<()> {
        instructions::execute_withdraw_reward::handler(ctx, amount)
    }

    pub fn close_automation(ctx: Context<CloseAutomation>) -> Result<()> {
        instructions::close_automation::handler(ctx)
    }
}
