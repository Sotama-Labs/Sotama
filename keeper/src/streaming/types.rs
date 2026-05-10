use solana_sdk::pubkey::Pubkey;

#[derive(Clone, Debug)]
pub struct LogEvent {
    pub signature: String,
    pub slot: u64,
    pub logs: Vec<String>,
    pub err: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AccountUpdate {
    pub account: Pubkey,
    pub slot: u64,
    pub lamports: u64,
    pub data: Vec<u8>,
}
