use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::SotamaError;
use crate::events::AutomationCreated;
use crate::state::{Automation, Config, MIN_AMOUNT_LAMPORTS};

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
    watched_account: Pubkey,
    destination: Pubkey,
    amount_lamports: u64,
) -> Result<()> {
    require!(
        amount_lamports >= MIN_AMOUNT_LAMPORTS,
        SotamaError::DepositTooSmall
    );

    let nonce = ctx.accounts.config.automation_count;
    let now = Clock::get()?.unix_timestamp;

    let automation = &mut ctx.accounts.automation;
    automation.owner = ctx.accounts.owner.key();
    automation.nonce = nonce;
    automation.watched_account = watched_account;
    automation.destination = destination;
    automation.amount_lamports = amount_lamports;
    automation.executed = false;
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
        amount_lamports,
    )?;

    ctx.accounts.config.automation_count = nonce
        .checked_add(1)
        .ok_or(error!(SotamaError::DepositTooSmall))?;

    emit!(AutomationCreated {
        pubkey: automation.key(),
        owner: automation.owner,
        nonce,
        watched_account,
        destination,
        amount_lamports,
    });

    Ok(())
}
