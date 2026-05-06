use anchor_lang::prelude::*;

use crate::errors::SotamaError;

pub const MIN_AMOUNT_LAMPORTS: u64 = 1_000_000;

/// Action kind discriminators emitted in events. Match the order of
/// `ActionSpec` variants so a single `as u8` cast on the discriminator
/// would line up — but we use named constants to keep the wire format
/// independent of variant ordering.
pub mod action_kind {
    pub const TRANSFER_SOL: u8 = 0;
    pub const TRANSFER_SPL: u8 = 1;
    pub const STAKE_RESTAKE: u8 = 2;
    pub const STAKE_WITHDRAW_REWARD: u8 = 3;
}

/// Trigger kind discriminators emitted in events.
pub mod trigger_kind {
    pub const ACCOUNT_ACTIVITY: u8 = 0;
    pub const TOKEN_PRICE: u8 = 1;
    pub const STAKING_REWARD: u8 = 2;
}

/// Comparator codes for `TokenPrice` triggers. Stored as u8 because Anchor
/// IDL doesn't expose enums-with-data plus simple enums in a single account
/// without name collisions on every variant.
pub mod comparator {
    pub const BELOW: u8 = 0;
    pub const ABOVE: u8 = 1;
}

/// Sub-kind for `AccountActivity`. The on-chain program does not
/// distinguish between transfer and swap detection — the keeper does — but
/// storing the kind lets the indexer route the right subscriber.
pub mod account_kind {
    pub const TRANSFER: u8 = 0;
    pub const SWAP: u8 = 1;
}

/// Mode for `StakingReward` triggers. `Amount` fires when accrued reward
/// exceeds `value` lamports; `Time` fires every `value` seconds since the
/// last execution.
pub mod staking_mode {
    pub const AMOUNT: u8 = 0;
    pub const TIME: u8 = 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub enum TriggerSpec {
    /// Watched-account activity (transfer or swap). Detected off-chain by
    /// the keeper. The on-chain program trusts the keeper signer.
    AccountActivity {
        account: Pubkey,
        /// `Some(mint)` to filter to a specific SPL mint, `None` for any token.
        mint: Option<Pubkey>,
        /// `account_kind::TRANSFER` or `account_kind::SWAP`.
        kind: u8,
    },
    /// Pyth price crossing. Detected off-chain by the keeper polling
    /// Hermes. Stored threshold uses the same `expo` as the feed.
    TokenPrice {
        feed: Pubkey,
        /// `comparator::BELOW` or `comparator::ABOVE`.
        comparator: u8,
        /// Price threshold scaled to `10^expo` (matches Pyth's wire format).
        threshold: i64,
        /// Pyth feed exponent (negative for decimals). Captured at create
        /// time so the keeper can normalize against future feed updates.
        expo: i32,
    },
    /// Stake account reward trigger. The keeper polls the stake account
    /// and fires when the configured threshold (mode = AMOUNT) is reached
    /// or the configured interval (mode = TIME) elapses.
    StakingReward {
        stake_account: Pubkey,
        /// `staking_mode::AMOUNT` or `staking_mode::TIME`.
        mode: u8,
        /// AMOUNT mode: lamports threshold. TIME mode: interval in seconds.
        value: u64,
    },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub enum ActionSpec {
    /// Native SOL transfer from the automation PDA → destination.
    TransferSol {
        destination: Pubkey,
        amount: u64,
    },
    /// SPL token transfer from the automation PDA's ATA → destination's ATA.
    /// Both ATAs must be passed in as remaining accounts at execute time.
    TransferSpl {
        destination: Pubkey,
        mint: Pubkey,
        amount: u64,
    },
    /// Re-delegate the stake account's full balance (including accrued
    /// rewards) to its current vote account. The automation PDA must be
    /// the stake's `staker` authority.
    StakeRestake {
        stake_account: Pubkey,
        vote_account: Pubkey,
    },
    /// Withdraw the reward portion (current_lamports −
    /// delegation.stake − rent_exempt) from the stake account → destination
    /// wallet. The automation PDA must be the stake's `withdraw` authority.
    StakeWithdrawReward {
        stake_account: Pubkey,
        destination: Pubkey,
    },
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub paused: bool,
    pub automation_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Automation {
    pub owner: Pubkey,
    pub nonce: u64,
    pub trigger: TriggerSpec,
    pub action: ActionSpec,
    pub executed: bool,
    pub created_at: i64,
    pub executed_at: i64,
    pub bump: u8,
}

impl Automation {
    /// Returns the destination wallet declared by the action, if the
    /// action transfers value out. Used by the close ix to reject closing
    /// an automation in flight (although the v2 program is single-shot
    /// and `executed` already gates this).
    pub fn action_destination(&self) -> Option<Pubkey> {
        match &self.action {
            ActionSpec::TransferSol { destination, .. } => Some(*destination),
            ActionSpec::TransferSpl { destination, .. } => Some(*destination),
            ActionSpec::StakeWithdrawReward { destination, .. } => Some(*destination),
            ActionSpec::StakeRestake { .. } => None,
        }
    }

    /// Returns the stake account referenced by either the trigger or the
    /// action (whichever ones reference one). Used by the keeper for
    /// indexing purposes.
    pub fn stake_account(&self) -> Option<Pubkey> {
        if let TriggerSpec::StakingReward { stake_account, .. } = &self.trigger {
            return Some(*stake_account);
        }
        match &self.action {
            ActionSpec::StakeRestake { stake_account, .. } => Some(*stake_account),
            ActionSpec::StakeWithdrawReward { stake_account, .. } => Some(*stake_account),
            _ => None,
        }
    }
}

impl TriggerSpec {
    /// Sanity-check the encoded byte fields on a TriggerSpec. Always run
    /// at create time so on-chain triggers can never have unrepresentable
    /// comparator/kind/mode bytes.
    pub fn validate(&self) -> Result<()> {
        match self {
            TriggerSpec::AccountActivity { kind, .. } => {
                require!(
                    *kind == account_kind::TRANSFER || *kind == account_kind::SWAP,
                    SotamaError::BadAccountKind
                );
            }
            TriggerSpec::TokenPrice {
                comparator: c, expo, ..
            } => {
                require!(
                    *c == comparator::BELOW || *c == comparator::ABOVE,
                    SotamaError::BadComparator
                );
                require!(*expo <= 0, SotamaError::BadPythExpo);
            }
            TriggerSpec::StakingReward { mode, .. } => {
                require!(
                    *mode == staking_mode::AMOUNT || *mode == staking_mode::TIME,
                    SotamaError::BadStakingMode
                );
            }
        }
        Ok(())
    }

    /// Single-byte discriminator used in `AutomationCreated` events.
    pub fn kind_byte(&self) -> u8 {
        match self {
            TriggerSpec::AccountActivity { .. } => trigger_kind::ACCOUNT_ACTIVITY,
            TriggerSpec::TokenPrice { .. } => trigger_kind::TOKEN_PRICE,
            TriggerSpec::StakingReward { .. } => trigger_kind::STAKING_REWARD,
        }
    }

    /// Primary watched/feed/stake pubkey, surfaced in events for indexers.
    pub fn primary_pubkey(&self) -> Pubkey {
        match self {
            TriggerSpec::AccountActivity { account, .. } => *account,
            TriggerSpec::TokenPrice { feed, .. } => *feed,
            TriggerSpec::StakingReward { stake_account, .. } => *stake_account,
        }
    }
}

impl ActionSpec {
    pub fn kind_byte(&self) -> u8 {
        match self {
            ActionSpec::TransferSol { .. } => action_kind::TRANSFER_SOL,
            ActionSpec::TransferSpl { .. } => action_kind::TRANSFER_SPL,
            ActionSpec::StakeRestake { .. } => action_kind::STAKE_RESTAKE,
            ActionSpec::StakeWithdrawReward { .. } => action_kind::STAKE_WITHDRAW_REWARD,
        }
    }
}
