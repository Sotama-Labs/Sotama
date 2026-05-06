use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::hash::Hash;
use solana_sdk::instruction::Instruction;
use solana_sdk::message::Message;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::rent::Rent;
use solana_sdk::transaction::Transaction;
use solana_stake_interface::state::StakeStateV2;
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::program::{
    associated_token_address, build_execute_automation_ix, build_execute_automation_spl_ix,
    build_execute_restake_ix, build_execute_withdraw_reward_ix, config_pda,
};
use crate::signer::KeeperSigner;
use crate::state::ActionSpec;
use crate::types::{AutomationCtx, TriggerEvent};

const PRIORITY_FEE_DEFAULT_MICROLAMPORTS: u64 = 50_000;
const COMPUTE_UNIT_LIMIT: u32 = 200_000;
const RECENT_TRIGGER_CACHE_SIZE: usize = 4_096;

/// Per-keeper-session deduplication state — see executor module docs in
/// the v1 keeper (kept verbatim).
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
            source = evt.source,
            correlation = %evt.correlation,
            matches = evt.matches.len(),
            "executor: trigger received"
        );
        for ctx in evt.matches {
            let pubkey = ctx.pubkey;
            let claim_result = {
                let mut g = dedupe.lock().expect("dedupe lock");
                g.try_claim(pubkey, &evt.correlation)
            };
            if let Some(reason) = claim_result {
                debug!(
                    automation = %pubkey,
                    correlation = %evt.correlation,
                    reason,
                    "executor: trigger skipped"
                );
                continue;
            }
            let cfg = cfg.clone();
            let http = http.clone();
            let correlation = evt.correlation.clone();
            let dedupe = dedupe.clone();
            tokio::spawn(async move {
                let result = execute_one(&cfg, &http, &config, &ctx).await;
                match result {
                    Ok(sig) => {
                        dedupe
                            .lock()
                            .expect("dedupe lock")
                            .release_success(pubkey);
                        info!(
                            automation = %pubkey,
                            correlation = %correlation,
                            execute_sig = %sig,
                            "executor: ix sent"
                        );
                    }
                    Err(e) => {
                        let msg = e.to_string();
                        let already_executed = msg.contains("AlreadyExecuted")
                            || msg.contains("alreadyExecuted")
                            || msg.contains("0x1770");
                        let interval_not_elapsed = msg.contains("TimeIntervalNotElapsed")
                            || msg.contains("timeIntervalNotElapsed");
                        dedupe.lock().expect("dedupe lock").release_failure(
                            pubkey,
                            already_executed,
                        );
                        if already_executed {
                            info!(
                                automation = %pubkey,
                                "executor: AlreadyExecuted (no-op, on-chain dedupe caught it)"
                            );
                        } else if interval_not_elapsed {
                            debug!(
                                automation = %pubkey,
                                "executor: time interval not elapsed yet — will retry next tick"
                            );
                        } else {
                            warn!(
                                automation = %pubkey,
                                error = %msg,
                                "executor: ix failed (will retry on next trigger)"
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
) -> Result<String> {
    let rpc =
        RpcClient::new_with_commitment(cfg.rpc_url.clone(), CommitmentConfig::confirmed());

    let exec_ix = build_action_ix(&rpc, &cfg.program_id, &cfg.keeper_pubkey, config, ctx).await?;
    let blockhash = rpc.get_latest_blockhash().await?;

    let mut ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(COMPUTE_UNIT_LIMIT),
        ComputeBudgetInstruction::set_compute_unit_price(PRIORITY_FEE_DEFAULT_MICROLAMPORTS),
        exec_ix,
    ];
    let probe_tx =
        sign_tx(cfg.signer.as_ref(), &cfg.keeper_pubkey, &ixs, blockhash).await?;

    let micro_lamports = match estimate_priority_fee(http, &cfg.rpc_url, &probe_tx).await {
        Ok(m) => m.max(1_000),
        Err(e) => {
            debug!(error = %e, "priority fee estimate failed; using default");
            PRIORITY_FEE_DEFAULT_MICROLAMPORTS
        }
    };

    ixs[1] = ComputeBudgetInstruction::set_compute_unit_price(micro_lamports);
    let final_tx =
        sign_tx(cfg.signer.as_ref(), &cfg.keeper_pubkey, &ixs, blockhash).await?;

    debug!(
        automation = %ctx.pubkey,
        action = ?ctx.action,
        priority_fee = micro_lamports,
        "executor: sending tx via helius sender"
    );

    send_via_helius(http, &cfg.sender_url, &final_tx).await
}

/// Build, serialize, and sign a Transaction via the configured signer.
/// Equivalent to `Transaction::new_signed_with_payer` but routes
/// signing through `KeeperSigner` so prod can use Turnkey.
async fn sign_tx(
    signer: &dyn KeeperSigner,
    payer: &Pubkey,
    ixs: &[Instruction],
    blockhash: Hash,
) -> Result<Transaction> {
    let message = Message::new_with_blockhash(ixs, Some(payer), &blockhash);
    let mut tx = Transaction::new_unsigned(message);
    let sig = signer.sign_message(&tx.message_data()).await?;
    tx.signatures = vec![sig];
    Ok(tx)
}

async fn build_action_ix(
    rpc: &RpcClient,
    program_id: &Pubkey,
    keeper: &Pubkey,
    config: &Pubkey,
    ctx: &AutomationCtx,
) -> Result<Instruction> {
    match &ctx.action {
        ActionSpec::TransferSol { destination, .. } => Ok(build_execute_automation_ix(
            program_id,
            keeper,
            config,
            &ctx.pubkey,
            destination,
        )),
        ActionSpec::TransferSpl {
            destination, mint, ..
        } => {
            let automation_ata = associated_token_address(&ctx.pubkey, mint);
            let destination_ata = associated_token_address(destination, mint);
            Ok(build_execute_automation_spl_ix(
                program_id,
                keeper,
                config,
                &ctx.pubkey,
                mint,
                &automation_ata,
                &destination_ata,
            ))
        }
        ActionSpec::StakeRestake {
            stake_account,
            vote_account,
        } => Ok(build_execute_restake_ix(
            program_id,
            keeper,
            config,
            &ctx.pubkey,
            stake_account,
            vote_account,
        )),
        ActionSpec::StakeWithdrawReward {
            stake_account,
            destination,
        } => {
            let amount = compute_reward_lamports(rpc, stake_account).await?;
            if amount == 0 {
                return Err(anyhow!("withdraw_reward: stake account has no withdrawable reward"));
            }
            Ok(build_execute_withdraw_reward_ix(
                program_id,
                keeper,
                config,
                &ctx.pubkey,
                stake_account,
                destination,
                amount,
            ))
        }
    }
}

async fn compute_reward_lamports(rpc: &RpcClient, stake_account: &Pubkey) -> Result<u64> {
    let info = rpc
        .get_account(stake_account)
        .await
        .map_err(|e| anyhow!("fetch stake account: {e}"))?;
    let lamports = info.lamports;
    let rent_exempt = Rent::default().minimum_balance(info.data.len());
    let stake_state: StakeStateV2 = bincode::deserialize(&info.data)
        .map_err(|e| anyhow!("parse stake state: {e}"))?;
    let delegation = match stake_state {
        StakeStateV2::Stake(_, stake, _) => stake.delegation.stake,
        _ => 0,
    };
    Ok(lamports
        .saturating_sub(delegation)
        .saturating_sub(rent_exempt))
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
