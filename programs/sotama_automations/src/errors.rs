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
    #[msg("Action mismatch — provided accounts do not match the configured action")]
    ActionMismatch,
    #[msg("SPL mint mismatch")]
    WrongMint,
    #[msg("Stake account does not match automation")]
    WrongStakeAccount,
    #[msg("Vote account does not match automation")]
    WrongVoteAccount,
    #[msg("Token-price comparator is not 0 (below) or 1 (above)")]
    BadComparator,
    #[msg("Account-activity kind is not 0 (transfer) or 1 (swap)")]
    BadAccountKind,
    #[msg("Staking-reward mode is not 0 (amount) or 1 (time)")]
    BadStakingMode,
    #[msg("Pyth feed expo cannot be positive")]
    BadPythExpo,
    #[msg("Time-based trigger fired before the configured interval elapsed")]
    TimeIntervalNotElapsed,
    #[msg("Account count or layout does not match for SPL transfer")]
    BadSplAccounts,
    #[msg("Account count or layout does not match for stake action")]
    BadStakeAccounts,
}
