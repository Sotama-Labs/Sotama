use anchor_lang::prelude::*;

#[error_code]
pub enum SotamaError {
    #[msg("Automation has reached its terminal state and cannot fire again")]
    AutomationFinished,
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
    #[msg("Cadence configuration is invalid (e.g. Repeat total = 0 or Until deadline not in the future)")]
    BadCadence,
    #[msg("Minimum interval between fires has not elapsed yet")]
    MinIntervalNotElapsed,
    #[msg("Until-cadence deadline has passed; automation is now terminal")]
    DeadlineExpired,
    #[msg("Swap input mint does not match automation")]
    WrongInputMint,
    #[msg("Swap output mint does not match automation")]
    WrongOutputMint,
    #[msg("Account count or layout does not match for swap action")]
    BadSwapAccounts,
    #[msg("Inner swap instruction must target the Jupiter v6 program")]
    WrongSwapProgram,
    #[msg("Output ATA balance did not increase by at least min_amount_out — slippage exceeded")]
    SlippageExceeded,
    #[msg("Swap actions cannot use the Until cadence — total runs must be bounded so the deposit can cover all fires")]
    SwapUntilNotSupported,
    #[msg("Deposit amount overflowed during cadence multiplication")]
    DepositOverflow,
    #[msg("Account count or layout does not match for SPL transfer")]
    BadSplAccounts,
    #[msg("Account count or layout does not match for stake action")]
    BadStakeAccounts,
    #[msg("Linked-rule fee deposit would push the PDA below rent-exempt minimum")]
    LinkedFeePoolBelowRent,
    #[msg("Fee debit exceeds MAX_LINK_FEE_LAMPORTS")]
    LinkFeeCapExceeded,
    #[msg("Linked downstream automation account is missing or wrong")]
    MissingDownstreamAccount,
    #[msg("Linked downstream pubkey does not match the action's linked_downstream")]
    DownstreamMismatch,
    #[msg("Fee topup output mint must be wrapped SOL")]
    BadFeeTopupOutput,
    #[msg("Fee topup output ATA must be owned by the automation PDA")]
    BadFeeTopupOwner,
}
