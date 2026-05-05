use anchor_lang::prelude::*;

use crate::events::AutomationClosed;
use crate::state::Automation;

#[derive(Accounts)]
pub struct CloseAutomation<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,

    #[account(
        mut,
        close = owner,
        seeds = [
            b"automation",
            owner.key().as_ref(),
            &automation.nonce.to_le_bytes(),
        ],
        bump = automation.bump,
        has_one = owner,
    )]
    pub automation: Account<'info, Automation>,
}

pub fn handler(ctx: Context<CloseAutomation>) -> Result<()> {
    let automation = &ctx.accounts.automation;
    let refund = automation.to_account_info().lamports();

    emit!(AutomationClosed {
        pubkey: automation.key(),
        owner: ctx.accounts.owner.key(),
        refund_lamports: refund,
    });

    Ok(())
}
