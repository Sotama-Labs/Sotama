use sha2::{Digest, Sha256};
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminators_are_anchor_compatible() {
        let a = automation_discriminator();
        let e = execute_automation_discriminator();
        assert_eq!(a.len(), 8);
        assert_eq!(e.len(), 8);
        assert_ne!(a, e);
    }
}
