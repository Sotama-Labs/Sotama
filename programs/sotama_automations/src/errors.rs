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
    #[msg("Token-price comparator is not 0 (below) or 1 (above)")]
    BadComparator,
    #[msg("Account-activity kind is not 0 (transfer) or 1 (swap)")]
    BadAccountKind,
    #[msg("Pyth feed expo cannot be positive")]
    BadPythExpo,
    #[msg("AssetPrice oracle source byte is not a recognized provider")]
    BadOracleSource,
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
    #[msg("Fee topup is not enabled for this automation")]
    FeeTopupNotEnabled,
    #[msg("Bridge is not enabled for this automation.")]
    BridgeNotEnabled,
    #[msg("Bridge output ATA mint must equal the automation's input mint.")]
    BadBridgeOutput,
    #[msg("Bridge output ATA owner must be the automation PDA.")]
    BadBridgeOwner,
    #[msg("Bridge swap delivered fewer tokens than min_amount_out.")]
    BridgeSlippageExceeded,
    #[msg("Fee parameter exceeds protocol cap")]
    FeeTooLarge,
    #[msg("Swap fee in basis points exceeds MAX_SWAP_FEE_BPS")]
    SwapFeeTooLarge,
    #[msg("Time fee per day exceeds MAX_TIME_FEE_LAMPORTS_PER_DAY")]
    TimeFeeTooLarge,
    #[msg("Treasury output ATA mint does not match the swap's output mint")]
    BadTreasuryOutput,
    #[msg("Treasury output ATA owner does not match Config.treasury")]
    BadTreasuryOwner,
    #[msg("Provided treasury account does not match Config.treasury")]
    WrongTreasury,
    #[msg("Program is in terminal shutdown — operation rejected")]
    Shutdown,
    #[msg("Operation requires Config.shutdown = true (kill-switch only)")]
    NotShutdown,
    #[msg("Shutdown is one-way; cannot be cleared once set")]
    ShutdownAlreadySet,
    #[msg("Caller is neither the automation owner nor the program admin")]
    UnauthorizedCloser,
    #[msg("Close pair accounts must be (PDA-owned ATA, owner-owned ATA) of matching mint != input_mint.")]
    BadCloseAccounts,
    #[msg("Jupiter CPI consumed more input than amount_in — keeper accelerated more fires than the action authorizes")]
    InputConsumedExceedsAmountIn,
}
