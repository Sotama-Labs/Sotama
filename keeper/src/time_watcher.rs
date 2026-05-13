//! TimeElapsed trigger watcher.
//!
//! Ticks at `cfg.time_watcher_interval` (default 60s) and scans the
//! active set for any rule whose `created_at + duration_secs <= now`.
//! For each due rule, emits a `TriggerEvent` to the executor.
//!
//! The watcher does not persist "already fired" state — re-fires are
//! prevented by the on-chain `Cadence::Once` flip to `finished` after
//! the first successful execute. The `recently_fired` HashSet here
//! is just a per-session optimization so the watcher doesn't keep
//! emitting events between fire and the next indexer reconcile (which
//! removes finished automations from the watched set).
//!
//! Compute cost: O(n) per tick over TimeElapsed automations only,
//! which is essentially free — no network calls, no oracle dispatch,
//! just a `now >= deadline` compare per row.

use anyhow::Result;
use solana_sdk::pubkey::Pubkey;
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{debug, info};

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;
use crate::state::TriggerSpec;
use crate::types::{AutomationCtx, TriggerEvent};

pub async fn run(
    cfg: Arc<KeeperConfig>,
    set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
) -> Result<()> {
    info!(
        interval_secs = cfg.time_watcher_interval.as_secs(),
        "time_watcher: starting"
    );
    let mut tick = interval(cfg.time_watcher_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let mut recently_fired: HashSet<Pubkey> = HashSet::new();

    loop {
        tick.tick().await;
        let set = set_rx.borrow().clone();
        if set.time_triggers.is_empty() {
            // Drop stale fired-set entries when there's nothing to scan;
            // active automations refill on next tick.
            recently_fired.clear();
            continue;
        }

        // Drop entries that the indexer has since removed (the rule
        // executed, on-chain flipped finished, indexer pruned it). Keeps
        // `recently_fired` from growing forever.
        let active: HashSet<Pubkey> = set.time_triggers.iter().map(|c| c.pubkey).collect();
        recently_fired.retain(|pk| active.contains(pk));

        let now = unix_now();
        let mut due: Vec<AutomationCtx> = Vec::new();
        for ctx in &set.time_triggers {
            if recently_fired.contains(&ctx.pubkey) {
                continue;
            }
            // Tail-of-chain rules waiting on upstream output are skipped
            // here too: a time-trigger that fires every minute on an
            // empty input ATA would just hit `SkipEmptyUpstreamATA`.
            if !ctx.armed {
                continue;
            }
            let TriggerSpec::TimeElapsed { duration_secs } = &ctx.trigger else {
                continue;
            };
            let deadline = ctx.created_at.saturating_add(*duration_secs as i64);
            if now >= deadline {
                due.push(ctx.clone());
                recently_fired.insert(ctx.pubkey);
            }
        }

        if due.is_empty() {
            debug!(
                pending = set.time_triggers.len(),
                "time_watcher: no rules due"
            );
            continue;
        }

        info!(count = due.len(), "time_watcher: emitting events for due rules");
        let evt = TriggerEvent {
            source: "time_watcher",
            correlation: format!("time:{now}"),
            matches: due,
            depth: 0,
            snapshot: None,
        };
        if trigger_tx.send(evt).await.is_err() {
            // Executor channel closed — shutdown in progress.
            return Ok(());
        }
    }
}

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
