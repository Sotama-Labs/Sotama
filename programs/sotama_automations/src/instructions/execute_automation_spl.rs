use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer as SplTransfer};

use crate::errors::SotamaError;
use crate::events::AutomationExecuted;
use crate::state::{ActionSpec, Automation, Config};

#[derive(Accounts)]
pub struct ExecuteAutomationSpl<'info> {
    pub keeper: Signer<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [
            b"automation",
            automation.owner.as_ref(),
            &automation.nonce.to_le_bytes(),
        ],
        bump = automation.bump,
    )]
    pub automation: Account<'info, Automation>,

    pub mint: Account<'info, Mint>,

    /// Source ATA owned by the automation PDA.
    #[account(
        mut,
        constraint = automation_ata.mint == mint.key() @ SotamaError::WrongMint,
        constraint = automation_ata.owner == automation.key() @ SotamaError::BadSplAccounts,
    )]
    pub automation_ata: Account<'info, TokenAccount>,

    /// Destination ATA — owned by the action's declared destination
    /// wallet. Must be pre-created by the keeper / caller.
    #[account(
        mut,
        constraint = destination_ata.mint == mint.key() @ SotamaError::WrongMint,
    )]
    pub destination_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ExecuteAutomationSpl>) -> Result<()> {
    require!(!ctx.accounts.config.paused, SotamaError::Paused);
    require!(!ctx.accounts.config.shutdown, SotamaError::Shutdown);
    require_keys_eq!(
        ctx.accounts.keeper.key(),
        ctx.accounts.config.keeper,
        SotamaError::UnauthorizedKeeper
    );

    let automation = &mut ctx.accounts.automation;
    let now = Clock::get()?.unix_timestamp;
    automation.check_can_fire(now)?;

    let (destination_wallet, mint_key, amount) = match &automation.action {
        ActionSpec::TransferSpl {
            destination,
            mint,
            amount,
        } => (*destination, *mint, *amount),
        _ => return err!(SotamaError::ActionMismatch),
    };
    require_keys_eq!(
        mint_key,
        ctx.accounts.mint.key(),
        SotamaError::WrongMint
    );
    require_keys_eq!(
        ctx.accounts.destination_ata.owner,
        destination_wallet,
        SotamaError::WrongDestination
    );

    // Sign as the automation PDA.
    let owner_key = automation.owner;
    let nonce_bytes = automation.nonce.to_le_bytes();
    let bump = [automation.bump];
    let pda_seeds: &[&[u8]] = &[
        b"automation",
        owner_key.as_ref(),
        nonce_bytes.as_ref(),
        bump.as_ref(),
    ];
    let signer_seeds: &[&[&[u8]]] = &[pda_seeds];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SplTransfer {
                from: ctx.accounts.automation_ata.to_account_info(),
                to: ctx.accounts.destination_ata.to_account_info(),
                authority: automation.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    automation.advance(now);

    emit!(AutomationExecuted {
        pubkey: automation.key(),
        action_kind: automation.action.kind_byte(),
        amount,
        executions: automation.executions,
        finished: automation.finished,
    });

    Ok(())
}
