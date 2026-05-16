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
use crate::program::{
    associated_token_address_for_program, automation_discriminator, spl_token_program_id,
    token_2022_program_id,
};
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
            crate::state::TriggerSpec::AccountActivity { account, mint, .. } => {
                for key in account_activity_watch_keys(account, mint) {
                    self.account_triggers
                        .entry(key)
                        .or_default()
                        .push(ctx.clone());
                }
            }
            crate::state::TriggerSpec::AssetPrice { feed, .. } => {
                self.price_triggers.entry(*feed).or_default().push(ctx);
            }
            crate::state::TriggerSpec::TimeElapsed { .. } => {
                self.time_triggers.push(ctx);
            }
            crate::state::TriggerSpec::PriceRelativeToFill { .. } => {
                // PriceRelativeToFill triggers have no fixed feed or account
                // to index — they are evaluated on every heartbeat tick by
                // the price_watcher against the FillCache. Stored only in
                // `by_pubkey` so the evaluator can iterate them.
                // No separate index bucket needed.
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
        let changed = match ev {
            DeltaApply::Upsert(ctx) => {
                self.remove_by_pubkey(&ctx.pubkey);
                self.insert_ctx(ctx);
                true
            }
            DeltaApply::Remove(pubkey) => self.remove_by_pubkey(&pubkey),
        };
        if changed {
            // `armed` is a cross-rule derived flag (depends on whether
            // an upstream rule exists with executions>0). Any insert or
            // remove can flip the armed state of one or more rules, so
            // recompute over the entire `by_pubkey` index and propagate
            // back to the trigger-bucket copies before watchers next
            // observe the set.
            self.recompute_armed();
        }
        changed
    }

    /// Recompute `armed` across the full set and propagate the result
    /// to every index bucket (`by_pubkey` + `account_triggers` +
    /// `price_triggers` + `time_triggers`). Called by `apply_delta`
    /// after a mutation; full reconciles use `compute_armed` on the
    /// raw vec directly before constructing the WatchedSet.
    fn recompute_armed(&mut self) {
        let mut items: Vec<AutomationCtx> = self.by_pubkey.values().cloned().collect();
        compute_armed(&mut items);
        let armed_by_pk: HashMap<Pubkey, bool> =
            items.iter().map(|c| (c.pubkey, c.armed)).collect();
        for (pk, ctx) in self.by_pubkey.iter_mut() {
            if let Some(a) = armed_by_pk.get(pk) {
                ctx.armed = *a;
            }
        }
        for ctxs in self.account_triggers.values_mut() {
            for ctx in ctxs.iter_mut() {
                if let Some(a) = armed_by_pk.get(&ctx.pubkey) {
                    ctx.armed = *a;
                }
            }
        }
        for ctxs in self.price_triggers.values_mut() {
            for ctx in ctxs.iter_mut() {
                if let Some(a) = armed_by_pk.get(&ctx.pubkey) {
                    ctx.armed = *a;
                }
            }
        }
        for ctx in self.time_triggers.iter_mut() {
            if let Some(a) = armed_by_pk.get(&ctx.pubkey) {
                ctx.armed = *a;
            }
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
    fn fingerprint(&self) -> Vec<(Pubkey, u8, Pubkey, Pubkey, u8)> {
        let mut out: Vec<(Pubkey, u8, Pubkey, Pubkey, u8)> = self
            .by_pubkey
            .iter()
            .map(|(pk, ctx)| {
                let (kind, target, aux, source) = match &ctx.trigger {
                    crate::state::TriggerSpec::AccountActivity {
                        account,
                        mint,
                        kind,
                        ..
                    } => (0u8, *account, mint.unwrap_or_default(), *kind),
                    crate::state::TriggerSpec::AssetPrice {
                        feed,
                        quote_mint,
                        source,
                        ..
                    } => (1u8, *feed, quote_mint.unwrap_or_default(), *source),
                    crate::state::TriggerSpec::TimeElapsed { .. } => {
                        // No watched account/feed; trigger spec is
                        // immutable after create, so the outer
                        // automation pubkey already disambiguates.
                        (2u8, Pubkey::default(), Pubkey::default(), 0u8)
                    }
                    crate::state::TriggerSpec::PriceRelativeToFill {
                        upstream,
                        direction,
                        ..
                    } => {
                        // Upstream pubkey is the primary discriminating field.
                        (3u8, *upstream, Pubkey::default(), *direction)
                    }
                };
                (*pk, kind, target, aux, source)
            })
            .collect();
        out.sort_unstable();
        out
    }

    pub fn len(&self) -> usize {
        self.by_pubkey.len()
    }

    /// All vault targets currently needed by bridge-aware automations.
    /// Derived from each automation's `vault_targets()` helper.
    /// Deduplicated. The vault manager computes the ATA for each target
    /// and subscribes via accountSubscribe so balance updates are pushed
    /// rather than polled.
    pub fn active_vault_targets(&self) -> Vec<crate::types::VaultTarget> {
        let mut s: HashSet<crate::types::VaultTarget> = HashSet::new();
        for ctx in self.by_pubkey.values() {
            for t in ctx.vault_targets() {
                s.insert(t);
            }
        }
        s.into_iter().collect()
    }

    /// All feed_id strings currently watched by price triggers (deduplicated,
    /// hex-encoded). For Pyth feeds the key is the feed_id hex; the Hermes SSE
    /// endpoint expects these as `ids[]` query params. The orchestrator just
    /// passes these through — both Lazer and Hermes paths share this set.
    pub fn active_feed_ids(&self) -> Vec<String> {
        self.price_triggers
            .keys()
            .map(|pk| hex::encode(pk.to_bytes()))
            .collect()
    }

    /// All SPL mints that need Jupiter price coverage for the cache-driven
    /// evaluator. This is the union of:
    ///
    /// - Mints where `oracle_source == JUPITER` is the BASE of any trigger
    ///   (`feed` field stores the SPL mint for Jupiter-sourced triggers).
    /// - Mints used as `quote_mint` in any AssetPrice trigger where the
    ///   mint is NOT in the Pyth catalog (i.e. SPL-quoted ratios that need
    ///   a Jupiter probe for the quote leg — covers Pyth/Jup and Jup/Jup).
    ///
    /// Used by `main.rs` to drive the mint probe's watch channel.
    pub fn active_jupiter_mints(
        &self,
        pyth_catalog: &crate::pyth_catalog::PythCatalog,
    ) -> Vec<solana_sdk::pubkey::Pubkey> {
        let mut s: HashSet<solana_sdk::pubkey::Pubkey> = HashSet::new();
        for ctx in self.by_pubkey.values() {
            if let crate::state::TriggerSpec::AssetPrice {
                feed,
                source,
                quote_mint,
                ..
            } = &ctx.trigger
            {
                // Base leg: Jupiter-sourced triggers store the SPL mint in `feed`.
                if *source == crate::state::oracle_source::JUPITER {
                    s.insert(*feed);
                }
                // Quote leg: any SPL mint not in the Pyth catalog needs a Jupiter probe.
                if let Some(qm) = quote_mint {
                    if !pyth_catalog.contains_key(&qm.to_bytes()) {
                        s.insert(*qm);
                    }
                }
            }
        }
        s.into_iter().collect()
    }
}

pub fn account_activity_watch_keys(account: &Pubkey, mint: &Option<Pubkey>) -> Vec<Pubkey> {
    let Some(mint) = mint else {
        return vec![*account];
    };
    let mut keys = Vec::with_capacity(3);
    keys.push(*account);
    let legacy_ata = associated_token_address_for_program(account, mint, spl_token_program_id());
    if !keys.contains(&legacy_ata) {
        keys.push(legacy_ata);
    }
    let token_2022_ata =
        associated_token_address_for_program(account, mint, token_2022_program_id());
    if !keys.contains(&token_2022_ata) {
        keys.push(token_2022_ata);
    }
    keys
}

pub async fn seed_initial(cfg: &KeeperConfig) -> Result<Vec<AutomationCtx>> {
    let client = make_client(cfg);
    fetch_active(&client, &cfg.program_id).await
}

/// Perform a single full reconcile: fetch all active automations via
/// `getProgramAccounts`, build a fresh `WatchedSet`, and publish it via
/// `set_tx.send_if_modified` when the fingerprint has changed.
///
/// Called by both the 60s periodic loop (`run`) and the reconnect handler
/// in main.rs whenever a WS reconnect sentinel is received.
pub async fn reconcile_once(
    client: &RpcClient,
    set_tx: &watch::Sender<WatchedSet>,
    program_id: &Pubkey,
) -> Result<()> {
    let active = fetch_active(client, program_id).await?;
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
        debug!(
            active = set_tx.borrow().len(),
            "indexer: reconcile (no change)"
        );
    }
    Ok(())
}

pub async fn run(cfg: Arc<KeeperConfig>, set_tx: watch::Sender<WatchedSet>) -> Result<()> {
    let client = make_client(&cfg);
    let mut tick = interval(cfg.reconcile_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    tick.tick().await; // burn the immediate first tick — main already seeded.

    loop {
        tick.tick().await;
        if let Err(e) = reconcile_once(&client, &set_tx, &cfg.program_id).await {
            warn!(error = %e, "indexer: reconcile failed (will retry)");
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
                        executions: a.executions,
                        // Provisional; compute_armed below resolves the
                        // cross-rule dependency once the whole set is in hand.
                        armed: true,
                    });
                }
            }
            Err(e) => warn!(pubkey = %pubkey, error = %e, "skipping unparseable account"),
        }
    }
    compute_armed(&mut out);
    Ok(out)
}

/// In-place fill of `armed` for every ctx in the set.
///
/// A `consume_upstream_output=true` Swap rule is armed iff some other
/// rule in the same set has `linked_downstream == Some(self.pubkey)`
/// AND `executions > 0` — i.e., an upstream has actually fired and
/// (presumably) deposited into this rule's input ATA.
///
/// Why this matters: without this gate, tail-of-chain rules whose
/// trigger is satisfied (e.g. "sell when price > $1.002" on a pegged
/// asset) emit a TriggerEvent on every price tick. The executor then
/// calls `get_token_account_balance` only to discover the input ATA
/// is empty (upstream hasn't fired yet) and skips via
/// `SkipEmptyUpstreamATA`. Gating at the indexer level eliminates the
/// per-tick RPC waste entirely until the upstream actually fires.
///
/// Non-`consume_upstream_output` rules are always armed — they fund
/// their own input from the PDA's pre-allocated balance.
pub fn compute_armed(items: &mut [AutomationCtx]) {
    use crate::state::ActionSpec;
    // Build pubkey → executions index from the current set so we can
    // resolve each tail rule's upstream in one pass without O(N²) work.
    let exec_by_pk: std::collections::HashMap<Pubkey, u32> =
        items.iter().map(|c| (c.pubkey, c.executions)).collect();
    // Map each pubkey to the set of upstreams that point at it.
    // A pubkey can have multiple upstreams in principle (multiple
    // chains converging) — if ANY upstream has fired, the tail is armed.
    let mut upstream_executed: std::collections::HashMap<Pubkey, bool> =
        std::collections::HashMap::new();
    for c in items.iter() {
        if let ActionSpec::Swap {
            linked_downstream: Some(d),
            ..
        } = &c.action
        {
            let already = upstream_executed.get(d).copied().unwrap_or(false);
            let fired = exec_by_pk.get(&c.pubkey).copied().unwrap_or(0) > 0;
            upstream_executed.insert(*d, already || fired);
        }
    }
    for c in items.iter_mut() {
        c.armed = match &c.action {
            ActionSpec::Swap {
                consume_upstream_output: true,
                ..
            } => upstream_executed.get(&c.pubkey).copied().unwrap_or(false),
            _ => true,
        };
    }
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
            executions: a.executions,
            // Provisional; `WatchedSet::apply_delta` calls
            // `recompute_armed` immediately after the insert so the
            // cross-rule resolution lands before any watcher reads it.
            armed: true,
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
        // Filled events do not change the WatchedSet — the automation still
        // exists and only the fill record (in FillCache) changes. Return
        // None so the lifecycle apply task skips the send_if_modified call.
        AutomationLifecycle::Filled(_) => Ok(None),
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
