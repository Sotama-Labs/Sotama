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
use crate::events::AutomationLifecycle;
use crate::program::automation_discriminator;
use crate::state::Automation;
use crate::types::AutomationCtx;

/// Sub-classification of active automations by trigger kind. Each map's
/// key is the off-chain monitor's "primary watch target" — the watched
/// account for AccountActivity, the Pyth feed for AssetPrice. Values
/// are lists because multiple automations can share the same target.
/// `time_triggers` is a flat list because TimeElapsed has no watch
/// target — the watcher iterates and checks each rule's deadline.
#[derive(Debug, Clone, Default)]
pub struct WatchedSet {
    pub by_pubkey: HashMap<Pubkey, AutomationCtx>,
    pub account_triggers: HashMap<Pubkey, Vec<AutomationCtx>>,
    pub price_triggers: HashMap<Pubkey, Vec<AutomationCtx>>,
    pub time_triggers: Vec<AutomationCtx>,
}

impl WatchedSet {
    pub fn from_index(items: Vec<AutomationCtx>) -> Self {
        let mut s = Self::default();
        for ctx in items {
            s.insert_ctx(ctx);
        }
        s
    }

    /// Insert a single `AutomationCtx` into every relevant index.
    /// Idempotent only if the caller has already called `remove_by_pubkey`
    /// for updated entries (to avoid duplicates in the trigger vecs).
    fn insert_ctx(&mut self, ctx: AutomationCtx) {
        self.by_pubkey.insert(ctx.pubkey, ctx.clone());
        match &ctx.trigger {
            crate::state::TriggerSpec::AccountActivity { account, .. } => {
                self.account_triggers.entry(*account).or_default().push(ctx);
            }
            crate::state::TriggerSpec::AssetPrice { feed, .. } => {
                self.price_triggers.entry(*feed).or_default().push(ctx);
            }
            crate::state::TriggerSpec::TimeElapsed { .. } => {
                self.time_triggers.push(ctx);
            }
        }
    }

    /// Remove every index entry associated with `pubkey`.
    /// Returns `true` if any entry was found and removed.
    fn remove_by_pubkey(&mut self, pubkey: &Pubkey) -> bool {
        let removed = self.by_pubkey.remove(pubkey).is_some();
        // account_triggers: remove ctx from vec; drop empty vecs.
        self.account_triggers.retain(|_, ctxs| {
            ctxs.retain(|c| &c.pubkey != pubkey);
            !ctxs.is_empty()
        });
        // price_triggers: same pattern.
        self.price_triggers.retain(|_, ctxs| {
            ctxs.retain(|c| &c.pubkey != pubkey);
            !ctxs.is_empty()
        });
        // time_triggers is a flat Vec.
        let before = self.time_triggers.len();
        self.time_triggers.retain(|c| &c.pubkey != pubkey);
        removed || self.time_triggers.len() < before
    }

    /// Async delta-apply: handles a single lifecycle event by fetching the
    /// on-chain account when needed (Created/Updated) or removing it from
    /// every index (Finished) without an RPC call.
    ///
    /// The caller holds `&mut self` obtained via `watch::Sender::send_if_modified`
    /// or equivalent. The async fetch happens *before* the mutable borrow — see
    /// `apply_lifecycle_event` free function which orchestrates this correctly.
    pub fn apply_delta(&mut self, ev: DeltaApply) -> bool {
        match ev {
            DeltaApply::Upsert(ctx) => {
                self.remove_by_pubkey(&ctx.pubkey);
                self.insert_ctx(ctx);
                true
            }
            DeltaApply::Remove(pubkey) => self.remove_by_pubkey(&pubkey),
        }
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
                    crate::state::TriggerSpec::TimeElapsed { .. } => {
                        // No watched account/feed; trigger spec is
                        // immutable after create, so the outer
                        // automation pubkey already disambiguates.
                        (2u8, Pubkey::default(), 0u8)
                    }
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
                        bridge_enabled: a.bridge_enabled,
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

// ---------------------------------------------------------------------------
// Delta-apply helpers for the events subscriber (Task 9)
// ---------------------------------------------------------------------------

/// Resolved action for `WatchedSet::apply_delta`. Produced by the async
/// fetch path (`apply_lifecycle_event`) and consumed synchronously inside
/// `watch::Sender::send_if_modified`.
pub enum DeltaApply {
    /// Insert or replace an automation (Created / Updated event).
    Upsert(AutomationCtx),
    /// Remove an automation without fetching (Finished event).
    Remove(Pubkey),
}

/// Decode a single account blob (including the 8-byte discriminator) into
/// an `AutomationCtx`. Returns `None` when the account is finished or
/// can't be parsed — the caller should skip/warn rather than crash.
fn decode_automation_to_ctx(pubkey: Pubkey, data: &[u8]) -> Option<AutomationCtx> {
    match Automation::from_account_data(data) {
        Ok(a) if !a.finished => Some(AutomationCtx {
            pubkey,
            owner: a.owner,
            nonce: a.nonce,
            created_at: a.created_at,
            trigger: a.trigger,
            action: a.action,
            bridge_enabled: a.bridge_enabled,
        }),
        Ok(_) => None, // account exists but is marked finished — treat as removal
        Err(e) => {
            warn!(pubkey = %pubkey, error = %e, "events: skipping unparseable account");
            None
        }
    }
}

/// Async half of lifecycle processing. Fetches the account (for Created /
/// Updated) and returns a `DeltaApply` ready for synchronous mutation of
/// the `WatchedSet` via `send_if_modified`.
///
/// The two-phase design (async fetch → sync mutate) avoids holding an async
/// lock while making RPC calls: `watch::Sender::send_if_modified` is
/// synchronous, so all awaits must complete before entering the closure.
pub async fn resolve_lifecycle(
    rpc: &RpcClient,
    ev: &AutomationLifecycle,
) -> Result<Option<DeltaApply>> {
    match ev {
        AutomationLifecycle::Created(e) => {
            let pubkey = e.automation;
            fetch_and_resolve(rpc, pubkey).await
        }
        AutomationLifecycle::Updated(e) => {
            let pubkey = e.automation;
            fetch_and_resolve(rpc, pubkey).await
        }
        AutomationLifecycle::Finished(e) => Ok(Some(DeltaApply::Remove(e.automation))),
    }
}

async fn fetch_and_resolve(rpc: &RpcClient, pubkey: Pubkey) -> Result<Option<DeltaApply>> {
    let account = rpc
        .get_account(&pubkey)
        .await
        .map_err(|e| anyhow!("getAccount({pubkey}) failed: {e}"))?;
    match decode_automation_to_ctx(pubkey, &account.data) {
        Some(ctx) => Ok(Some(DeltaApply::Upsert(ctx))),
        // Account is finished — treat as removal so our index stays clean.
        None => Ok(Some(DeltaApply::Remove(pubkey))),
    }
}
