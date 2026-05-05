use anyhow::{anyhow, Result};
use base64::Engine as _;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_client::rpc_filter::{Memcmp, MemcmpEncodedBytes, RpcFilterType};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::program::automation_discriminator;
use crate::state::Automation;
use crate::types::AutomationCtx;

#[derive(Debug, Clone, Default)]
pub struct WatchedSet {
    pub by_pubkey: HashMap<Pubkey, AutomationCtx>,
    pub by_watched: HashMap<Pubkey, Vec<AutomationCtx>>,
}

impl WatchedSet {
    pub fn from_index(items: Vec<AutomationCtx>) -> Self {
        let mut by_pubkey = HashMap::with_capacity(items.len());
        let mut by_watched: HashMap<Pubkey, Vec<AutomationCtx>> = HashMap::new();
        for ctx in items {
            by_watched
                .entry(ctx.watched_account)
                .or_default()
                .push(ctx.clone());
            by_pubkey.insert(ctx.pubkey, ctx);
        }
        Self {
            by_pubkey,
            by_watched,
        }
    }

    pub fn watched_accounts(&self) -> Vec<Pubkey> {
        self.by_watched.keys().copied().collect()
    }

    pub fn matches(&self, watched: &Pubkey) -> &[AutomationCtx] {
        self.by_watched
            .get(watched)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    fn account_set(&self) -> HashSet<Pubkey> {
        self.by_pubkey.keys().copied().collect()
    }

    pub fn len(&self) -> usize {
        self.by_pubkey.len()
    }
}

pub async fn seed_initial(cfg: &KeeperConfig) -> Result<Vec<AutomationCtx>> {
    let client = make_client(cfg);
    fetch_active(&client, &cfg.program_id).await
}

pub async fn run(cfg: Arc<KeeperConfig>, set_tx: watch::Sender<WatchedSet>) -> Result<()> {
    let client = Arc::new(make_client(&cfg));
    let mut tick = interval(cfg.reconcile_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    tick.tick().await; // burn the immediate first tick — main already seeded.

    loop {
        tick.tick().await;
        match fetch_active(&client, &cfg.program_id).await {
            Ok(active) => {
                let new_set = WatchedSet::from_index(active);
                let changed = set_tx.send_if_modified(|current| {
                    let prev_keys = current.account_set();
                    let next_keys = new_set.account_set();
                    if prev_keys == next_keys {
                        false
                    } else {
                        let added: Vec<_> = next_keys.difference(&prev_keys).copied().collect();
                        let removed: Vec<_> = prev_keys.difference(&next_keys).copied().collect();
                        info!(
                            added = added.len(),
                            removed = removed.len(),
                            total = next_keys.len(),
                            "indexer: watched-set changed"
                        );
                        for p in &added {
                            debug!(pubkey = %p, "added");
                        }
                        for p in &removed {
                            debug!(pubkey = %p, "removed");
                        }
                        *current = new_set;
                        true
                    }
                });
                if !changed {
                    debug!(active = set_tx.borrow().len(), "indexer: reconcile (no change)");
                }
            }
            Err(e) => warn!(error = %e, "indexer: reconcile failed (will retry)"),
        }
    }
}

fn make_client(cfg: &KeeperConfig) -> RpcClient {
    RpcClient::new_with_commitment(cfg.rpc_url.clone(), CommitmentConfig::confirmed())
}

async fn fetch_active(client: &RpcClient, program_id: &Pubkey) -> Result<Vec<AutomationCtx>> {
    let disc = automation_discriminator();
    let cfg = RpcProgramAccountsConfig {
        filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new(
            0,
            MemcmpEncodedBytes::Base58(bs58::encode(disc).into_string()),
        ))]),
        account_config: RpcAccountInfoConfig {
            encoding: Some(solana_account_decoder::UiAccountEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            ..Default::default()
        },
        with_context: None,
        sort_results: None,
    };

    let raw = client
        .get_program_accounts_with_config(program_id, cfg)
        .await
        .map_err(|e| anyhow!("getProgramAccounts failed: {e}"))?;

    let mut out = Vec::with_capacity(raw.len());
    for (pubkey, account) in raw {
        match Automation::from_account_data(&account.data) {
            Ok(a) => {
                if !a.executed {
                    out.push(AutomationCtx {
                        pubkey,
                        owner: a.owner,
                        nonce: a.nonce,
                        watched_account: a.watched_account,
                        destination: a.destination,
                        amount_lamports: a.amount_lamports,
                    });
                }
            }
            Err(e) => warn!(pubkey = %pubkey, error = %e, "skipping unparseable account"),
        }
    }
    Ok(out)
}

// Suppress "unused" warning for base64 helper we keep around for future use.
#[allow(dead_code)]
fn _decode_b64(s: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| anyhow!("base64 decode failed: {e}"))
}
