use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::Transaction;
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::program::{build_execute_automation_ix, config_pda};
use crate::types::{AutomationCtx, TriggerEvent};

const PRIORITY_FEE_DEFAULT_MICROLAMPORTS: u64 = 50_000;
const COMPUTE_UNIT_LIMIT: u32 = 60_000;
const RECENT_TRIGGER_CACHE_SIZE: usize = 4_096;

/// Per-keeper-session deduplication state.
///
///   • `fired`           — automations we've already sent execute_automation
///                         for (and either succeeded or got AlreadyExecuted).
///                         Single-shot: once here, never re-attempt.
///   • `recent_triggers` — bounded FIFO of (automation, triggering_sig) pairs.
///                         Catches Helius transactionSubscribe re-delivering
///                         the same notification across reconnects, shard
///                         respawns, or commitment-level callbacks.
///   • `in_flight`       — pubkeys with a send task currently running. Holds
///                         the slot atomically across the spawn boundary so
///                         two simultaneous triggers can't both claim it.
struct Dedupe {
    fired: HashSet<Pubkey>,
    recent_triggers: HashSet<(Pubkey, String)>,
    recent_order: VecDeque<(Pubkey, String)>,
    in_flight: HashSet<Pubkey>,
}

impl Dedupe {
    fn new() -> Self {
        Self {
            fired: HashSet::new(),
            recent_triggers: HashSet::new(),
            recent_order: VecDeque::new(),
            in_flight: HashSet::new(),
        }
    }

    /// Returns Some(reason) if this trigger should be skipped, or None to
    /// proceed. On None, marks (pubkey, sig) as seen and adds pubkey to
    /// in_flight — the caller MUST eventually call `release_*`.
    fn try_claim(&mut self, pubkey: Pubkey, sig: &str) -> Option<&'static str> {
        if self.fired.contains(&pubkey) {
            return Some("already fired this session");
        }
        let key = (pubkey, sig.to_string());
        if self.recent_triggers.contains(&key) {
            return Some("duplicate trigger event");
        }
        if self.in_flight.contains(&pubkey) {
            return Some("send in flight");
        }
        self.recent_triggers.insert(key.clone());
        self.recent_order.push_back(key);
        while self.recent_order.len() > RECENT_TRIGGER_CACHE_SIZE {
            if let Some(old) = self.recent_order.pop_front() {
                self.recent_triggers.remove(&old);
            }
        }
        self.in_flight.insert(pubkey);
        None
    }

    fn release_success(&mut self, pubkey: Pubkey) {
        self.in_flight.remove(&pubkey);
        self.fired.insert(pubkey);
    }

    fn release_failure(&mut self, pubkey: Pubkey, treat_as_done: bool) {
        self.in_flight.remove(&pubkey);
        if treat_as_done {
            self.fired.insert(pubkey);
        }
    }
}

pub async fn run(cfg: Arc<KeeperConfig>, mut rx: mpsc::Receiver<TriggerEvent>) -> Result<()> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let config = config_pda(&cfg.program_id);
    let dedupe: Arc<Mutex<Dedupe>> = Arc::new(Mutex::new(Dedupe::new()));

    while let Some(evt) = rx.recv().await {
        debug!(
            watched = %evt.watched_account,
            sig = %evt.triggering_signature,
            matches = evt.matches.len(),
            "executor: trigger received"
        );
        for ctx in evt.matches {
            let pubkey = ctx.pubkey;
            let claim_result = {
                let mut g = dedupe.lock().expect("dedupe lock");
                g.try_claim(pubkey, &evt.triggering_signature)
            };
            if let Some(reason) = claim_result {
                debug!(
                    automation = %pubkey,
                    sig = %evt.triggering_signature,
                    reason,
                    "executor: trigger skipped"
                );
                continue;
            }
            let cfg = cfg.clone();
            let http = http.clone();
            let triggering = evt.triggering_signature.clone();
            let dedupe = dedupe.clone();
            tokio::spawn(async move {
                let result = execute_one(&cfg, &http, &config, &ctx, &triggering).await;
                match result {
                    Ok(sig) => {
                        dedupe
                            .lock()
                            .expect("dedupe lock")
                            .release_success(pubkey);
                        info!(
                            automation = %pubkey,
                            triggering = %triggering,
                            execute_sig = %sig,
                            "executor: execute_automation sent"
                        );
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        let already_executed = msg.contains("AlreadyExecuted")
                            || msg.contains("0x1770");
                        dedupe
                            .lock()
                            .expect("dedupe lock")
                            .release_failure(pubkey, already_executed);
                        if already_executed {
                            info!(
                                automation = %pubkey,
                                "executor: AlreadyExecuted (no-op, on-chain dedupe caught it)"
                            );
                        } else {
                            warn!(
                                automation = %pubkey,
                                error = %msg,
                                "executor: execute_automation failed (will retry on next trigger)"
                            );
                        }
                    }
                }
            });
        }
    }
    Ok(())
}

async fn execute_one(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    config: &Pubkey,
    ctx: &AutomationCtx,
    triggering_signature: &str,
) -> Result<String> {
    let rpc =
        RpcClient::new_with_commitment(cfg.rpc_url.clone(), CommitmentConfig::confirmed());

    let exec_ix = build_execute_automation_ix(
        &cfg.program_id,
        &cfg.keeper_pubkey,
        config,
        &ctx.pubkey,
        &ctx.destination,
    );

    let blockhash = rpc.get_latest_blockhash().await?;

    let mut ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(COMPUTE_UNIT_LIMIT),
        ComputeBudgetInstruction::set_compute_unit_price(PRIORITY_FEE_DEFAULT_MICROLAMPORTS),
        exec_ix,
    ];
    let probe_tx = Transaction::new_signed_with_payer(
        &ixs,
        Some(&cfg.keeper_pubkey),
        &[&cfg.keeper_keypair],
        blockhash,
    );

    let micro_lamports = match estimate_priority_fee(http, &cfg.rpc_url, &probe_tx).await {
        Ok(m) => m.max(1_000),
        Err(e) => {
            debug!(error = %e, "priority fee estimate failed; using default");
            PRIORITY_FEE_DEFAULT_MICROLAMPORTS
        }
    };

    ixs[1] = ComputeBudgetInstruction::set_compute_unit_price(micro_lamports);
    let final_tx = Transaction::new_signed_with_payer(
        &ixs,
        Some(&cfg.keeper_pubkey),
        &[&cfg.keeper_keypair],
        blockhash,
    );

    debug!(
        automation = %ctx.pubkey,
        priority_fee = micro_lamports,
        triggering = %triggering_signature,
        "executor: sending tx via helius sender"
    );

    send_via_helius(http, &cfg.sender_url, &final_tx).await
}

async fn estimate_priority_fee(
    http: &reqwest::Client,
    rpc_url: &str,
    tx: &Transaction,
) -> Result<u64> {
    let serialized = bincode::serialize(tx).map_err(|e| anyhow!("bincode serialize: {e}"))?;
    let b58 = bs58::encode(&serialized).into_string();
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getPriorityFeeEstimate",
        "params": [{
            "transaction": b58,
            "options": { "priorityLevel": "Medium" }
        }]
    });
    let resp: Value = http.post(rpc_url).json(&body).send().await?.json().await?;
    let n = resp["result"]["priorityFeeEstimate"]
        .as_f64()
        .ok_or_else(|| anyhow!("missing priorityFeeEstimate in {resp}"))?;
    Ok(n.round() as u64)
}

async fn send_via_helius(
    http: &reqwest::Client,
    sender_url: &str,
    tx: &Transaction,
) -> Result<String> {
    let serialized = bincode::serialize(tx).map_err(|e| anyhow!("bincode serialize: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&serialized);
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [
            b64,
            { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }
        ]
    });
    let resp: Value = http.post(sender_url).json(&body).send().await?.json().await?;
    if let Some(err) = resp.get("error") {
        return Err(anyhow!("helius sendTransaction error: {err}"));
    }
    let sig = resp["result"]
        .as_str()
        .ok_or_else(|| anyhow!("missing signature in {resp}"))?
        .to_string();
    Ok(sig)
}
