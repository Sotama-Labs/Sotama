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

/// Sub-classification of active automations by trigger kind. Each map's
/// key is the off-chain monitor's "primary watch target" — the watched
/// account for AccountActivity, the Pyth feed for AssetPrice, the stake
/// account for StakingReward. Values are lists because multiple
/// automations can share the same target.
#[derive(Debug, Clone, Default)]
pub struct WatchedSet {
    pub by_pubkey: HashMap<Pubkey, AutomationCtx>,
    pub account_triggers: HashMap<Pubkey, Vec<AutomationCtx>>,
    pub price_triggers: HashMap<Pubkey, Vec<AutomationCtx>>,
    pub stake_triggers: HashMap<Pubkey, Vec<AutomationCtx>>,
}

impl WatchedSet {
    pub fn from_index(items: Vec<AutomationCtx>) -> Self {
        let mut s = Self::default();
        for ctx in items {
            s.by_pubkey.insert(ctx.pubkey, ctx.clone());
            match &ctx.trigger {
                crate::state::TriggerSpec::AccountActivity { account, .. } => {
                    s.account_triggers.entry(*account).or_default().push(ctx);
                }
                crate::state::TriggerSpec::AssetPrice { feed, .. } => {
                    s.price_triggers.entry(*feed).or_default().push(ctx);
                }
                crate::state::TriggerSpec::StakingReward { stake_account, .. } => {
                    s.stake_triggers.entry(*stake_account).or_default().push(ctx);
                }
            }
        }
        s
    }

    pub fn account_watch_keys(&self) -> Vec<Pubkey> {
        self.account_triggers.keys().copied().collect()
    }

    pub fn price_feeds(&self) -> Vec<Pubkey> {
        self.price_triggers.keys().copied().collect()
    }

    /// Feeds (or mints, depending on source) for triggers using the given
    /// oracle adapter. Each watcher (Pyth Hermes, Pyth Lazer, Jupiter, …)
    /// calls this with its own `source` byte to get only the keys it
    /// should subscribe to. Adding a new oracle = pass a new source byte.
    pub fn price_feeds_for_source(&self, source: u8) -> Vec<Pubkey> {
        let mut out: Vec<Pubkey> = Vec::new();
        let mut seen: HashSet<Pubkey> = HashSet::new();
        for (feed, triggers) in &self.price_triggers {
            for ctx in triggers {
                if let crate::state::TriggerSpec::AssetPrice { source: s, .. } = &ctx.trigger {
                    if *s == source && seen.insert(*feed) {
                        out.push(*feed);
                        break;
                    }
                }
            }
        }
        out
    }

    pub fn stake_accounts(&self) -> Vec<Pubkey> {
        self.stake_triggers.keys().copied().collect()
    }

    pub fn account_matches(&self, watched: &Pubkey) -> &[AutomationCtx] {
        self.account_triggers
            .get(watched)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn price_matches(&self, feed: &Pubkey) -> &[AutomationCtx] {
        self.price_triggers
            .get(feed)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Matches for a given feed restricted to triggers using `source`.
    /// Each watcher uses this to evaluate only its own triggers.
    pub fn price_matches_for_source(&self, feed: &Pubkey, source: u8) -> Vec<AutomationCtx> {
        match self.price_triggers.get(feed) {
            Some(v) => v
                .iter()
                .filter(|ctx| {
                    matches!(
                        &ctx.trigger,
                        crate::state::TriggerSpec::AssetPrice { source: s, .. } if *s == source,
                    )
                })
                .cloned()
                .collect(),
            None => Vec::new(),
        }
    }

    pub fn stake_matches(&self, stake_account: &Pubkey) -> &[AutomationCtx] {
        self.stake_triggers
            .get(stake_account)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    /// Distinct quote mints across all `AssetPrice` triggers — the
    /// price_watcher probes Jupiter for each at evaluation time when
    /// the trigger is configured with a non-USD quote.
    pub fn asset_price_quote_mints(&self) -> Vec<Pubkey> {
        let mut out = HashSet::new();
        for triggers in self.price_triggers.values() {
            for ctx in triggers {
                if let crate::state::TriggerSpec::AssetPrice {
                    quote_mint: Some(m),
                    ..
                } = &ctx.trigger
                {
                    out.insert(*m);
                }
            }
        }
        out.into_iter().collect()
    }

    fn account_set(&self) -> HashSet<Pubkey> {
        self.by_pubkey.keys().copied().collect()
    }

    /// Content fingerprint covering every dimension a watcher actually
    /// cares about: PDA pubkey + trigger kind + primary target + oracle
    /// source. Catches in-place edits where the PDA stays the same but
    /// the trigger underneath swaps (e.g., feed swap or source flip from
    /// PYTH → JUPITER). The plain pubkey-set comparison used to miss
    /// those, leaving stale Lazer subscriptions behind (H2).
    fn fingerprint(&self) -> Vec<(Pubkey, u8, Pubkey, u8)> {
        let mut out: Vec<(Pubkey, u8, Pubkey, u8)> = self
            .by_pubkey
            .iter()
            .map(|(pk, ctx)| {
                let (kind, target, source) = match &ctx.trigger {
                    crate::state::TriggerSpec::AccountActivity { account, kind, .. } => {
                        (0u8, *account, *kind)
                    }
                    crate::state::TriggerSpec::AssetPrice { feed, source, .. } => {
                        (1u8, *feed, *source)
                    }
                    crate::state::TriggerSpec::StakingReward {
                        stake_account,
                        mode,
                        ..
                    } => (2u8, *stake_account, *mode),
                };
                (*pk, kind, target, source)
            })
            .collect();
        out.sort_unstable();
        out
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
                    let prev_fp = current.fingerprint();
                    let next_fp = new_set.fingerprint();
                    if prev_fp == next_fp {
                        false
                    } else {
                        let prev_keys = current.account_set();
                        let next_keys = new_set.account_set();
                        let added: Vec<_> = next_keys.difference(&prev_keys).copied().collect();
                        let removed: Vec<_> = prev_keys.difference(&next_keys).copied().collect();
                        info!(
                            added = added.len(),
                            removed = removed.len(),
                            total = next_keys.len(),
                            account_targets = new_set.account_triggers.len(),
                            price_targets = new_set.price_triggers.len(),
                            stake_targets = new_set.stake_triggers.len(),
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
                if !a.finished {
                    out.push(AutomationCtx {
                        pubkey,
                        owner: a.owner,
                        nonce: a.nonce,
                        created_at: a.created_at,
                        trigger: a.trigger,
                        action: a.action,
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
