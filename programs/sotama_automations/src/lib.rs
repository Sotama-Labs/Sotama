use anchor_lang::prelude::*;

declare_id!("3FCzDrB9KNUe2JJQFTKjWF1LNnHdcsw3FV5kN7SmGtdw");

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

    /// Rotate `Config.treasury` (where close-fee revenue lands). Admin
    /// only. Use to migrate from `admin` (default) to a dedicated
    /// fee-collection wallet or Squads multisig.
    pub fn update_treasury(ctx: Context<UpdateTreasury>, new_treasury: Pubkey) -> Result<()> {
        instructions::update_treasury::handler(ctx, new_treasury)
    }

    /// Rotate `Config.close_fee_lamports` (per-close protocol fee).
    /// Admin only. Capped at `MAX_CLOSE_FEE_LAMPORTS` (0.1 SOL) so a
    /// misconfig can't make rules un-closable.
    pub fn update_close_fee(ctx: Context<UpdateCloseFee>, new_fee_lamports: u64) -> Result<()> {
        instructions::update_close_fee::handler(ctx, new_fee_lamports)
    }

    /// One-shot devnet migration: realloc the v4.0 Config PDA to the
    /// v4.1 layout and initialize the new `treasury` + `close_fee_lamports`
    /// fields. Mainnet doesn't need this — its first `initialize_config`
    /// writes the v4.1 layout directly. Admin only.
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        instructions::migrate_config::handler(ctx)
    }

    /// Rotate `Config.admin`. Required for handing off control to a
    /// Squads multisig (or any other admin rotation). Admin only.
    /// Rejected when `Config.shutdown == true` — the Squads transition
    /// must happen during normal operation, before the kill switch.
    pub fn update_admin(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::update_admin::handler(ctx, new_admin)
    }

    /// One-way kill switch. Admin only. Sets `Config.shutdown = true`
    /// and locks `update_treasury`, `update_close_fee`, `update_admin`,
    /// `migrate_config`, all `execute_*`, and all `create_automation*`.
    /// Enables `admin_close_automation*` for the wind-down. Reverts on
    /// a second invocation (`ShutdownAlreadySet`).
    pub fn set_shutdown(ctx: Context<SetShutdown>) -> Result<()> {
        instructions::set_shutdown::handler(ctx)
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

    pub fn create_automation_swap(
        ctx: Context<CreateAutomationSwap>,
        trigger: TriggerSpec,
        action: ActionSpec,
        cadence: Cadence,
        min_interval_secs: u32,
        enable_fee_topup: bool,
    ) -> Result<()> {
        instructions::create_automation_swap::handler(
            ctx,
            trigger,
            action,
            cadence,
            min_interval_secs,
            enable_fee_topup,
        )
    }

    pub fn execute_automation(ctx: Context<ExecuteAutomation>) -> Result<()> {
        instructions::execute_automation::handler(ctx)
    }

    pub fn execute_automation_spl(ctx: Context<ExecuteAutomationSpl>) -> Result<()> {
        instructions::execute_automation_spl::handler(ctx)
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
    /// SOL actions and `close_automation_swap` for `Swap` actions.
    pub fn close_automation_spl(ctx: Context<CloseAutomationSpl>) -> Result<()> {
        instructions::close_automation_spl::handler(ctx)
    }

    /// Close a swap-action automation. Drains the PDA-owned input
    /// ATA back to the owner, closes the ATA, then closes the PDA.
    pub fn close_automation_swap(ctx: Context<CloseAutomationSwap>) -> Result<()> {
        instructions::close_automation_swap::handler(ctx)
    }

    /// Admin-driven kill-switch close for SOL-action automations.
    /// Requires `Config.shutdown == true`. Owner gets the SOL deposit
    /// (above-rent excess); treasury gets the rent_min.
    pub fn admin_close_automation(ctx: Context<AdminCloseAutomation>) -> Result<()> {
        instructions::admin_close_automation::handler(ctx)
    }

    /// Admin-driven kill-switch close for SPL-action automations.
    /// Requires `Config.shutdown == true`. Owner gets the SPL tokens
    /// (via PDA→owner ATA transfer); treasury gets all lamports
    /// (PDA rent + ATA rent).
    pub fn admin_close_automation_spl(ctx: Context<AdminCloseAutomationSpl>) -> Result<()> {
        instructions::admin_close_automation_spl::handler(ctx)
    }

    /// Admin-driven kill-switch close for swap-action automations.
    /// Requires `Config.shutdown == true`. Owner gets the unspent
    /// input mint (via PDA→owner ATA transfer); treasury gets all
    /// lamports (PDA rent + input-ATA rent).
    pub fn admin_close_automation_swap(ctx: Context<AdminCloseAutomationSwap>) -> Result<()> {
        instructions::admin_close_automation_swap::handler(ctx)
    }
}
