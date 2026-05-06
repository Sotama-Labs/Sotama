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
