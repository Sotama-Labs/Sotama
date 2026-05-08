use anchor_lang::prelude::*;

declare_id!("2gp9bMBEVpQp6Lyyg13Bw6XF9S9saAcm9C4XQ69T8ZqQ");

pub mod errors;
pub mod events;
pub mod instructions;
pub mod jupiter;
pub mod state;

use instructions::*;
use state::{ActionSpec, Cadence, TriggerSpec};

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
        cadence: Cadence,
        min_interval_secs: u32,
    ) -> Result<()> {
        instructions::create_automation::handler(ctx, trigger, action, cadence, min_interval_secs)
    }

    pub fn create_automation_spl(
        ctx: Context<CreateAutomationSpl>,
        trigger: TriggerSpec,
        action: ActionSpec,
        cadence: Cadence,
        min_interval_secs: u32,
    ) -> Result<()> {
        instructions::create_automation_spl::handler(
            ctx,
            trigger,
            action,
            cadence,
            min_interval_secs,
        )
    }

    pub fn create_automation_stake(
        ctx: Context<CreateAutomationStake>,
        trigger: TriggerSpec,
        action: ActionSpec,
        cadence: Cadence,
        min_interval_secs: u32,
    ) -> Result<()> {
        instructions::create_automation_stake::handler(
            ctx,
            trigger,
            action,
            cadence,
            min_interval_secs,
        )
    }

    pub fn create_automation_swap(
        ctx: Context<CreateAutomationSwap>,
        trigger: TriggerSpec,
        action: ActionSpec,
        cadence: Cadence,
        min_interval_secs: u32,
    ) -> Result<()> {
        instructions::create_automation_swap::handler(
            ctx,
            trigger,
            action,
            cadence,
            min_interval_secs,
        )
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

    pub fn execute_swap<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteSwap<'info>>,
        inner_ix_data: Vec<u8>,
        inner_ix_account_metas: Vec<jupiter::SwapAccountMeta>,
        input_ata_index: u8,
        output_ata_index: u8,
    ) -> Result<()> {
        instructions::execute_swap::handler(
            ctx,
            inner_ix_data,
            inner_ix_account_metas,
            input_ata_index,
            output_ata_index,
        )
    }

    pub fn execute_withdraw_reward(
        ctx: Context<ExecuteWithdrawReward>,
        amount: u64,
    ) -> Result<()> {
        instructions::execute_withdraw_reward::handler(ctx, amount)
    }

    /// Linked-rule fee debit. Bundled by the keeper before any
    /// `execute_*` ix when firing a downstream-of-link automation, so
    /// the fee debit and the action atomically succeed-or-fail. Caps
    /// `fee_lamports` at `MAX_LINK_FEE_LAMPORTS` and rejects below-rent
    /// debits.
    pub fn execute_link_fee_debit(
        ctx: Context<ExecuteLinkFeeDebit>,
        fee_lamports: u64,
    ) -> Result<()> {
        instructions::execute_link_fee_debit::handler(ctx, fee_lamports)
    }

    /// Keeper-driven token-to-wSOL conversion (auto-fee-management).
    /// Swaps a slice of the PDA's holdings into wSOL on the keeper's
    /// own ATA, then the keeper unwraps off-band to refill its tx-fee
    /// budget. Same Jupiter relay shape as `execute_swap`.
    pub fn execute_fee_topup<'info>(
        ctx: Context<'_, '_, '_, 'info, ExecuteFeeTopup<'info>>,
        inner_ix_data: Vec<u8>,
        inner_ix_account_metas: Vec<jupiter::SwapAccountMeta>,
        keeper_wsol_ata_index: u8,
    ) -> Result<()> {
        instructions::execute_fee_topup::handler(
            ctx,
            inner_ix_data,
            inner_ix_account_metas,
            keeper_wsol_ata_index,
        )
    }

    pub fn close_automation(ctx: Context<CloseAutomation>) -> Result<()> {
        instructions::close_automation::handler(ctx)
    }

    /// Close an SPL-action automation. Drains the PDA-owned ATA back
    /// to the owner's ATA, closes the ATA, then closes the PDA. Use
    /// this for `TransferSpl` actions; use `close_automation` for
    /// SOL/stake and `close_automation_swap` for `Swap` actions.
    pub fn close_automation_spl(ctx: Context<CloseAutomationSpl>) -> Result<()> {
        instructions::close_automation_spl::handler(ctx)
    }

    /// Close a swap-action automation. Drains the PDA-owned input
    /// ATA back to the owner, closes the ATA, then closes the PDA.
    pub fn close_automation_swap(ctx: Context<CloseAutomationSwap>) -> Result<()> {
        instructions::close_automation_swap::handler(ctx)
    }
}
