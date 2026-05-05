use solana_sdk::pubkey::Pubkey;

#[derive(Debug, Clone)]
pub struct AutomationCtx {
    pub pubkey: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub watched_account: Pubkey,
    pub destination: Pubkey,
    pub amount_lamports: u64,
}

#[derive(Debug, Clone)]
pub struct TriggerEvent {
    pub watched_account: Pubkey,
    pub triggering_signature: String,
    pub matches: Vec<AutomationCtx>,
}
