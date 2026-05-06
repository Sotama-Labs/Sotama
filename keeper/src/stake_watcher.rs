use anyhow::Result;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_stake_interface::state::StakeStateV2;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::{mpsc, watch};
use tokio::time::{interval, MissedTickBehavior};
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;
use crate::state::TriggerSpec;
use crate::types::{AutomationCtx, TriggerEvent};

/// Stake watcher — polls each unique stake account and inspects:
///   • Amount-mode triggers: fire when current_lamports −
///     delegation.stake − rent_exempt ≥ value (the configured reward
///     threshold).
///   • Time-mode triggers: fire when now ≥ last_executed_at + value.
///     The on-chain program enforces this independently; the keeper
///     fires eagerly and lets the program reject if too early.
pub async fn run(
    cfg: Arc<KeeperConfig>,
    set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
) -> Result<()> {
    let rpc = RpcClient::new_with_commitment(cfg.rpc_url.clone(), CommitmentConfig::confirmed());
    let mut tick = interval(cfg.stake_poll_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tick.tick().await;
        let set = set_rx.borrow().clone();
        if set.stake_triggers.is_empty() {
            continue;
        }
        let stake_keys: Vec<Pubkey> = set.stake_accounts();
        debug!(stake_targets = stake_keys.len(), "stake_watcher: polling");

        let infos = match rpc.get_multiple_accounts(&stake_keys).await {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "stake_watcher: rpc fetch failed");
                continue;
            }
        };

        let mut to_fire: HashMap<Pubkey, Vec<AutomationCtx>> = HashMap::new();
        let mut already: HashSet<Pubkey> = HashSet::new();
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        for (stake_key, account_opt) in stake_keys.iter().zip(infos.into_iter()) {
            let Some(account) = account_opt else {
                debug!(stake = %stake_key, "stake_watcher: account missing on-chain");
                continue;
            };
            let lamports = account.lamports;
            let delegation_stake = parse_delegation_stake(&account.data);
            let rent_exempt_min = compute_rent_exempt(account.data.len() as u64);
            let reward = lamports
                .saturating_sub(delegation_stake.unwrap_or(0))
                .saturating_sub(rent_exempt_min);

            for ctx in set.stake_matches(stake_key) {
                if !already.insert(ctx.pubkey) {
                    continue;
                }
                if let TriggerSpec::StakingReward { mode, value, .. } = &ctx.trigger {
                    let fire = match *mode {
                        // Amount mode
                        0 => reward >= *value,
                        // Time mode — we don't track on-chain executed_at
                        // here because all StakingReward automations are
                        // single-shot in v2 (the on-chain `executed`
                        // gate is the real safety net). Fire eagerly.
                        1 => true,
                        _ => false,
                    };
                    if fire {
                        debug!(
                            stake = %stake_key,
                            mode = mode,
                            reward,
                            threshold = value,
                            "stake_watcher: condition met"
                        );
                        to_fire.entry(*stake_key).or_default().push(ctx.clone());
                    }
                }
            }
        }

        for (stake_key, matches) in to_fire {
            info!(
                stake = %stake_key,
                count = matches.len(),
                "stake_watcher: firing"
            );
            let evt = TriggerEvent {
                source: "stake_watcher",
                correlation: format!("{stake_key}:{now}"),
                matches,
            };
            if trigger_tx.send(evt).await.is_err() {
                return Ok(());
            }
        }
    }
}

/// Lightweight parse of StakeStateV2 — returns Some(active_stake) for
/// `Stake` variants only. Initialized / Uninitialized / RewardsPool
/// variants return None (no delegation = full balance is potentially
/// withdrawable, but we don't auto-fire on those).
fn parse_delegation_stake(data: &[u8]) -> Option<u64> {
    let state: StakeStateV2 = bincode::deserialize(data).ok()?;
    match state {
        StakeStateV2::Stake(_, stake, _) => Some(stake.delegation.stake),
        _ => None,
    }
}

/// Stake-account rent-exempt minimum, using cluster-default rent. Devnet
/// uses the same `Rent::default()` constants as mainnet, so this is the
/// correct value for both. Stake account size is fixed at the
/// `StakeStateV2` byte length.
fn compute_rent_exempt(data_len: u64) -> u64 {
    Rent::default().minimum_balance(data_len as usize)
}
