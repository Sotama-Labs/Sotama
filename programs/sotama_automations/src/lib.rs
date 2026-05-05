use anchor_lang::prelude::*;

declare_id!("2gp9bMBEVpQp6Lyyg13Bw6XF9S9saAcm9C4XQ69T8ZqQ");

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

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
        watched_account: Pubkey,
        destination: Pubkey,
        amount_lamports: u64,
    ) -> Result<()> {
        instructions::create_automation::handler(ctx, watched_account, destination, amount_lamports)
    }

    pub fn execute_automation(ctx: Context<ExecuteAutomation>) -> Result<()> {
        instructions::execute_automation::handler(ctx)
    }

    pub fn close_automation(ctx: Context<CloseAutomation>) -> Result<()> {
        instructions::close_automation::handler(ctx)
    }
}
