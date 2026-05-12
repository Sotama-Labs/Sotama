//! Helius Sender helpers.
//!
//! Sender is Helius's ultra-low-latency dual-routed (validator + Jito)
//! `sendTransaction` endpoint. Per Helius docs (2026-02-27 spec) every
//! tx submitted to Sender must:
//!   • include a SystemProgram transfer of ≥ 0.0002 SOL to one of the
//!     known Jito tip accounts;
//!   • include a ComputeBudget set_compute_unit_price ix (already true
//!     for every Sotama tx);
//!   • be sent with `skipPreflight: true, maxRetries: 0` — the caller
//!     is expected to implement its own retry logic (we already do).
//!
//! Sender returns 50 TPS at 0 credits/tx on every Helius plan
//! including the free tier — opt-in is purely a "do I want the Jito
//! tip cost on every tx" tradeoff. For Sotama the math is:
//!   * stand-alone fires: keeper's main SOL balance pays the tip.
//!   * linked-chain fires: bundled `execute_link_fee_debit` already
//!     pulls a per-fire SOL fee from the PDA; the Jito tip comes out
//!     of the keeper's main balance, recovered via `execute_fee_topup`
//!     once the chain has earned enough USDC to convert.
//!
//! ## Region routing
//!
//! Frontend traffic goes through `https://sender.helius-rpc.com/fast`
//! (CORS-friendly). Backend services should hit
//! `http://{region}-sender.helius-rpc.com/fast` for lowest latency. We
//! pick the region from `cfg.sender_region` (auto-derived from
//! `FLY_REGION` when unset; falls back to the global hostname for
//! unknown regions).

use solana_sdk::pubkey::Pubkey;
use solana_sdk::system_instruction;
use std::str::FromStr;
use std::sync::OnceLock;

use crate::config::KeeperConfig;

/// Jito tip accounts on mainnet-beta. Helius round-robin recommends
/// picking one uniformly at random per tx — keeps no single tip
/// account from becoming a bottleneck during burst traffic. List comes
/// from Helius docs (2026-02-27 spec). Cached on first use.
fn jito_tip_accounts() -> &'static [Pubkey; 10] {
    static CELL: OnceLock<[Pubkey; 10]> = OnceLock::new();
    CELL.get_or_init(|| {
        [
            "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
            "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
            "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
            "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
            "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
            "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
            "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
            "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
            "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
            "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
        ]
        .map(|s| Pubkey::from_str(s).expect("hardcoded valid pubkey"))
    })
}

/// Pick a random Jito tip account. Uses thread-rng-equivalent (system
/// time low bits) so we don't pull in a heavy `rand` dep — round-robin
/// uniformity is not a correctness requirement here, just a fairness
/// nice-to-have to avoid hot-spotting a single tip address.
pub fn pick_jito_tip_account() -> &'static Pubkey {
    let accounts = jito_tip_accounts();
    let idx = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as usize % accounts.len())
        .unwrap_or(0);
    &accounts[idx]
}

/// Build a SystemProgram::transfer ix for the Jito tip. Append this to
/// every tx submitted via Helius Sender. The `from` pubkey is the
/// keeper signer (the tx's fee payer), and the random tip account is
/// fetched via `pick_jito_tip_account`.
pub fn build_jito_tip_ix(
    payer: &Pubkey,
    tip_lamports: u64,
) -> solana_sdk::instruction::Instruction {
    system_instruction::transfer(payer, pick_jito_tip_account(), tip_lamports)
}

/// Resolve the Sender endpoint to use for this keeper. When
/// `cfg.use_sender` is false, returns `None` and the caller should
/// post to the standard RPC. When true, picks the regional hostname
/// if `cfg.sender_region` is set, else the global frontend hostname.
pub fn sender_endpoint(cfg: &KeeperConfig) -> Option<String> {
    if !cfg.use_sender {
        return None;
    }
    match &cfg.sender_region {
        Some(region) => Some(format!("http://{region}-sender.helius-rpc.com/fast")),
        None => Some("https://sender.helius-rpc.com/fast".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ten_jito_tip_accounts_loaded() {
        let accs = jito_tip_accounts();
        assert_eq!(accs.len(), 10);
        // All distinct
        let mut sorted = accs.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 10);
    }

    #[test]
    fn pick_returns_one_of_known() {
        let accs = jito_tip_accounts();
        let picked = pick_jito_tip_account();
        assert!(accs.iter().any(|a| a == picked));
    }
}
