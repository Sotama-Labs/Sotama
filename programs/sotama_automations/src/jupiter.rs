//! Jupiter v6 aggregator constants. The integration model is:
//!
//! 1. The keeper calls Jupiter's `/build` endpoint off-chain to get a
//!    `swapInstruction` (programId + accounts + base64 data).
//! 2. The keeper invokes Sotama's `execute_swap`, passing:
//!    - The inner ix's account list as `remaining_accounts`
//!    - A parallel `Vec<SwapAccountMeta>` describing each remaining
//!      account's signer/writable flags (so we can rebuild the
//!      `AccountMeta` list the inner ix expects)
//!    - The inner ix's data bytes as a `Vec<u8>` arg
//!    - The indices of the PDA's input ATA and the destination's
//!      output ATA within the remaining-accounts list
//! 3. `execute_swap` validates the on-chain invariants (input/output
//!    mints, destination ATA owner, balance deltas, jupiter program
//!    address), then `invoke_signed`s the relayed ix with the PDA's
//!    seeds.
//!
//! This is a "trusted relay" pattern: the keeper is already a
//! configured signer in `Config.keeper`, so trusting it to format the
//! Jupiter ix is consistent with the rest of the keeper's authority.
//! The on-chain invariants prevent the keeper from redirecting funds.
//!
//! See `.claude/2026-05-07-mainnet-final.md` for the full integration
//! plan, including Jupiter `/build` API params and `maxAccounts` notes.

use anchor_lang::prelude::*;

/// Jupiter v6 aggregator program ID. Same on mainnet and devnet.
///
/// **Important:** this is a `const Pubkey` via `pubkey!`, NOT a
/// `declare_id!`. `declare_id!` stamps the IDL's top-level `address`
/// field with whichever ID it sees last in the crate; since Anchor
/// expands the lib.rs `declare_id!("2gp9bMBE…")` and then this
/// submodule's `declare_id!`, using the macro here would clobber the
/// IDL's program ID with Jupiter's. The `pubkey!` macro produces the
/// same `pub const ID: Pubkey` without that IDL side effect.
pub mod program {
    use anchor_lang::prelude::*;
    pub const ID: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
}

/// Mirror of Solana's `AccountMeta` flags, serialized over the wire so
/// the keeper can describe each relayed account's role without us
/// having to introspect AccountInfo flags (which on Solana would
/// require trusting the runtime's view, not the inner ix's view).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SwapAccountMeta {
    pub is_signer: bool,
    pub is_writable: bool,
}
