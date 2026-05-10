pub mod types;
pub mod ws_source;

use async_trait::async_trait;
use anyhow::Result;
use solana_sdk::pubkey::Pubkey;
use tokio::sync::mpsc;

pub use types::{AccountUpdate, LogEvent};

#[async_trait]
pub trait StreamSource: Send + Sync {
    async fn subscribe_logs(&self, program: Pubkey) -> Result<mpsc::Receiver<LogEvent>>;
    async fn subscribe_account(&self, account: Pubkey) -> Result<mpsc::Receiver<AccountUpdate>>;
}
