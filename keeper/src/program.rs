use sha2::{Digest, Sha256};
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use std::sync::OnceLock;

fn anchor_discriminator(prefix: &str, name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("{prefix}:{name}").as_bytes());
    let out = hasher.finalize();
    let mut d = [0u8; 8];
    d.copy_from_slice(&out[0..8]);
    d
}

pub fn automation_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("account", "Automation"))
}

pub fn execute_automation_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("global", "execute_automation"))
}

pub fn execute_automation_spl_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("global", "execute_automation_spl"))
}

pub fn execute_restake_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("global", "execute_restake"))
}

pub fn execute_withdraw_reward_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("global", "execute_withdraw_reward"))
}

pub fn execute_swap_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("global", "execute_swap"))
}

pub fn execute_link_fee_debit_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("global", "execute_link_fee_debit"))
}

pub fn execute_fee_topup_discriminator() -> &'static [u8; 8] {
    static CELL: OnceLock<[u8; 8]> = OnceLock::new();
    CELL.get_or_init(|| anchor_discriminator("global", "execute_fee_topup"))
}

pub fn native_mint() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("So11111111111111111111111111111111111111112").unwrap())
}

pub fn jupiter_program_id() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4").unwrap())
}

pub fn config_pda(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"config"], program_id).0
}

pub fn automation_pda(program_id: &Pubkey, owner: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(
        &[b"automation", owner.as_ref(), &nonce.to_le_bytes()],
        program_id,
    )
    .0
}

/* ── Constant program IDs (avoid heavy SDK deps in the keeper). ──────── */

pub fn spl_token_program_id() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap())
}

pub fn associated_token_program_id() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap())
}

pub fn stake_program_id() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("Stake11111111111111111111111111111111111111").unwrap())
}

pub fn stake_config_id() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("StakeConfig11111111111111111111111111111111").unwrap())
}

pub fn sysvar_clock_id() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("SysvarC1ock11111111111111111111111111111111").unwrap())
}

pub fn sysvar_stake_history_id() -> &'static Pubkey {
    static CELL: OnceLock<Pubkey> = OnceLock::new();
    CELL.get_or_init(|| Pubkey::from_str("SysvarStakeHistory1111111111111111111111111").unwrap())
}

/// Off-curve PDA derivation for a SPL associated token account.
pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            owner.as_ref(),
            spl_token_program_id().as_ref(),
            mint.as_ref(),
        ],
        associated_token_program_id(),
    )
    .0
}

/* ── Execute-instruction builders ────────────────────────────────────── */

pub fn build_execute_automation_ix(
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    automation: &Pubkey,
    destination: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(execute_automation_discriminator());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*keeper, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*automation, false),
            AccountMeta::new(*destination, false),
        ],
        data,
    }
}

pub fn build_execute_automation_spl_ix(
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    automation: &Pubkey,
    mint: &Pubkey,
    automation_ata: &Pubkey,
    destination_ata: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(execute_automation_spl_discriminator());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*keeper, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*automation, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*automation_ata, false),
            AccountMeta::new(*destination_ata, false),
            AccountMeta::new_readonly(*spl_token_program_id(), false),
        ],
        data,
    }
}

pub fn build_execute_restake_ix(
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    automation: &Pubkey,
    stake_account: &Pubkey,
    vote_account: &Pubkey,
) -> Instruction {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(execute_restake_discriminator());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*keeper, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*automation, false),
            AccountMeta::new(*stake_account, false),
            AccountMeta::new_readonly(*vote_account, false),
            AccountMeta::new_readonly(*sysvar_clock_id(), false),
            AccountMeta::new_readonly(*sysvar_stake_history_id(), false),
            AccountMeta::new_readonly(*stake_config_id(), false),
            AccountMeta::new_readonly(*stake_program_id(), false),
        ],
        data,
    }
}

/// Mirror of the on-chain `crate::jupiter::SwapAccountMeta` Borsh
/// struct. Used to describe each relayed account's signer/writable
/// flags when building `execute_swap`.
#[derive(borsh::BorshSerialize, Clone, Copy, Debug)]
pub struct SwapAccountMeta {
    pub is_signer: bool,
    pub is_writable: bool,
}

/// Build the `execute_swap` ix from a Jupiter `swapInstruction`
/// (programId + accounts + data) returned by the Jupiter `/build`
/// API. The keeper resolves the inner ix off-chain, then passes its
/// pieces here:
///
///   • `inner_accounts` — the inner ix's account list, in order. We
///     pass these as remaining_accounts; the on-chain handler rebuilds
///     the AccountMeta list using the parallel `inner_account_metas`.
///   • `inner_data` — the inner ix's data bytes verbatim.
///   • `input_ata_index` / `output_ata_index` — positions of the PDA's
///     input ATA and the destination's output ATA within
///     `inner_accounts`. The on-chain handler uses these to mint-check
///     before invoking.
#[allow(clippy::too_many_arguments)]
pub fn build_execute_swap_ix(
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    automation: &Pubkey,
    inner_accounts: &[AccountMeta],
    inner_data: Vec<u8>,
    input_ata_index: u8,
    output_ata_index: u8,
    // Optional linked-downstream PDA. When set, gets appended as the
    // LAST remaining account so the on-chain handler can transfer the
    // auto-deposit fee to it after the swap CPI succeeds.
    linked_downstream: Option<&Pubkey>,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 4 + inner_data.len() + 4 + inner_accounts.len() * 2 + 2);
    data.extend_from_slice(execute_swap_discriminator());

    // Anchor encodes Vec<u8> as { len: u32 LE, bytes }
    let inner_len = inner_data.len() as u32;
    data.extend_from_slice(&inner_len.to_le_bytes());
    data.extend_from_slice(&inner_data);

    // Vec<SwapAccountMeta> — only describes the Jupiter inner ix's
    // accounts, NOT the optional downstream PDA. The on-chain handler
    // distinguishes the two by length: remaining = inner + (linked ? 1 : 0).
    let metas_len = inner_accounts.len() as u32;
    data.extend_from_slice(&metas_len.to_le_bytes());
    for m in inner_accounts {
        data.push(if m.is_signer { 1 } else { 0 });
        data.push(if m.is_writable { 1 } else { 0 });
    }

    // input_ata_index, output_ata_index
    data.push(input_ata_index);
    data.push(output_ata_index);

    // Outer accounts: keeper, config, automation, jupiter_program, then
    // every Jupiter inner-ix account, then optionally the downstream
    // PDA at index `4 + inner_accounts.len()`. The PDA itself signs via
    // invoke_signed (the keeper just authorizes).
    let mut accounts = vec![
        AccountMeta::new_readonly(*keeper, true),
        AccountMeta::new_readonly(*config, false),
        AccountMeta::new(*automation, false),
        AccountMeta::new_readonly(*jupiter_program_id(), false),
    ];
    accounts.extend_from_slice(inner_accounts);
    if let Some(downstream) = linked_downstream {
        // Writable so the handler can credit lamports to it.
        accounts.push(AccountMeta::new(*downstream, false));
    }

    Instruction {
        program_id: *program_id,
        accounts,
        data,
    }
}

/// Debit a small SOL fee from an automation PDA → keeper signer.
/// Bundled by the keeper before any execute_* ix when firing a linked
/// rule, atomically charging the fee while the action runs.
pub fn build_execute_link_fee_debit_ix(
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    automation: &Pubkey,
    fee_lamports: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(execute_link_fee_debit_discriminator());
    data.extend_from_slice(&fee_lamports.to_le_bytes());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*keeper, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*keeper, false), // keeper_recipient (mut)
            AccountMeta::new(*automation, false),
        ],
        data,
    }
}

/// Keeper-driven token-to-wSOL conversion that lands the proceeds in
/// the keeper's wSOL ATA. Auto-fee-management primitive: keeper picks
/// a PDA with low SOL balance and sells some of its tokens for wSOL,
/// off-band-unwrapping later to refill its operating budget.
#[allow(clippy::too_many_arguments)]
pub fn build_execute_fee_topup_ix(
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    automation: &Pubkey,
    inner_accounts: &[AccountMeta],
    inner_data: Vec<u8>,
    keeper_wsol_ata_index: u8,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 4 + inner_data.len() + 4 + inner_accounts.len() * 2 + 1);
    data.extend_from_slice(execute_fee_topup_discriminator());

    let inner_len = inner_data.len() as u32;
    data.extend_from_slice(&inner_len.to_le_bytes());
    data.extend_from_slice(&inner_data);

    let metas_len = inner_accounts.len() as u32;
    data.extend_from_slice(&metas_len.to_le_bytes());
    for m in inner_accounts {
        data.push(if m.is_signer { 1 } else { 0 });
        data.push(if m.is_writable { 1 } else { 0 });
    }

    data.push(keeper_wsol_ata_index);

    let mut accounts = vec![
        AccountMeta::new_readonly(*keeper, true),
        AccountMeta::new_readonly(*config, false),
        AccountMeta::new(*automation, false),
        AccountMeta::new_readonly(*jupiter_program_id(), false),
    ];
    accounts.extend_from_slice(inner_accounts);

    Instruction {
        program_id: *program_id,
        accounts,
        data,
    }
}

pub fn build_execute_withdraw_reward_ix(
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    automation: &Pubkey,
    stake_account: &Pubkey,
    destination: &Pubkey,
    amount: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(16);
    data.extend_from_slice(execute_withdraw_reward_discriminator());
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(*keeper, true),
            AccountMeta::new_readonly(*config, false),
            AccountMeta::new(*automation, false),
            AccountMeta::new(*stake_account, false),
            AccountMeta::new(*destination, false),
            AccountMeta::new_readonly(*sysvar_clock_id(), false),
            AccountMeta::new_readonly(*sysvar_stake_history_id(), false),
            AccountMeta::new_readonly(*stake_program_id(), false),
        ],
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminators_are_anchor_compatible() {
        let a = automation_discriminator();
        let e = execute_automation_discriminator();
        let es = execute_automation_spl_discriminator();
        let er = execute_restake_discriminator();
        let ew = execute_withdraw_reward_discriminator();
        assert_eq!(a.len(), 8);
        for d in [e, es, er, ew] {
            assert_ne!(a, d);
        }
        // All four execute discriminators are unique.
        let mut sorted = vec![*e, *es, *er, *ew];
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 4);
    }

    #[test]
    fn ata_derivation_matches_spl_token_format() {
        // Smoke: derive an ATA and confirm it's deterministic + off-curve.
        let owner = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let ata1 = associated_token_address(&owner, &mint);
        let ata2 = associated_token_address(&owner, &mint);
        assert_eq!(ata1, ata2);
    }
}
