use anchor_lang::prelude::*;

#[error_code]
pub enum SotamaError {
    #[msg("Automation already executed")]
    AlreadyExecuted,
    #[msg("Caller is not the configured keeper")]
    UnauthorizedKeeper,
    #[msg("Destination account does not match automation")]
    WrongDestination,
    #[msg("Deposit amount is below the minimum")]
    DepositTooSmall,
    #[msg("Program is paused")]
    Paused,
}
