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
use solana_sdk::transaction::Transaction;
use std::collections::{HashSet, VecDeque};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::caches::blockhash::{BlockhashCache, CachedBlockhash};
use crate::caches::priority_fee::PriorityFeeCache;
use crate::config::KeeperConfig;
use crate::jupiter::{self, JupiterClient};
use crate::program::{
    associated_token_address, build_execute_automation_ix, build_execute_automation_spl_ix,
    build_execute_swap_ix, config_pda, jupiter_program_id,
};
use crate::revalidate::{self, RevalidateCtx};
use crate::signer::KeeperSigner;
use crate::state::ActionSpec;
use crate::types::{AutomationCtx, TriggerEvent};

/// Default compute-unit limit for SOL/SPL transfers.
const COMPUTE_UNIT_LIMIT_DEFAULT: u32 = 200_000;
/// Compute-unit limit for Jupiter swap relays. Routes through 3-4 AMMs
/// can consume 600k-1.2M CU; we allocate the upper bound so a deeper
/// route doesn't silently exceed and revert at the end.
const COMPUTE_UNIT_LIMIT_SWAP: u32 = 1_000_000;
const RECENT_TRIGGER_CACHE_SIZE: usize = 4_096;

/// Per-action compute budget selector. Matched on the action variant so
/// future ix types (fee topup, link fee debit) can declare their own
/// ceilings without cluttering the executor's hot path.
fn compute_unit_limit_for(action: &ActionSpec) -> u32 {
    match action {
        ActionSpec::Swap { .. } => COMPUTE_UNIT_LIMIT_SWAP,
        _ => COMPUTE_UNIT_LIMIT_DEFAULT,
    }
}

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

pub async fn run(
    cfg: Arc<KeeperConfig>,
    mut rx: mpsc::Receiver<TriggerEvent>,
    blockhash_cache: BlockhashCache,
    priority_fee_cache: PriorityFeeCache,
) -> Result<()> {
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
        // Spawn ONE task per event so different events still process in
        // parallel (different price feeds, different watched accounts).
        // Within a single event, matches are processed serially in
        // (created_at, nonce) order so the oldest user's tx lands first
        // and intra-batch revalidation can skip later matches whose
        // conditions no longer hold.
        let cfg_task = cfg.clone();
        let http_task = http.clone();
        let dedupe_task = dedupe.clone();
        let blockhash_cache_task = blockhash_cache.clone();
        let priority_fee_cache_task = priority_fee_cache.clone();
        tokio::spawn(async move {
            process_event(
                cfg_task,
                http_task,
                config,
                evt,
                dedupe_task,
                blockhash_cache_task,
                priority_fee_cache_task,
            )
            .await;
        });
    }
    Ok(())
}

async fn process_event(
    cfg: Arc<KeeperConfig>,
    http: reqwest::Client,
    config: Pubkey,
    evt: TriggerEvent,
    dedupe: Arc<Mutex<Dedupe>>,
    blockhash_cache: BlockhashCache,
    priority_fee_cache: PriorityFeeCache,
) {
    let depth = evt.depth;
    let mut matches = evt.matches;
    // Cross-user queue ordering: oldest rule fires first. Tie-break on
    // `nonce` (global monotonic counter) so two rules created in the
    // same block still have a deterministic order.
    sort_matches_for_queue(&mut matches);

    let rpc = Arc::new(RpcClient::new_with_commitment(
        cfg.rpc_url.clone(),
        CommitmentConfig::confirmed(),
    ));
    let rev = RevalidateCtx {
        http: http.clone(),
        rpc: rpc.clone(),
        hermes_url: cfg.hermes_url.clone(),
        jupiter: JupiterClient::new(http.clone(), cfg.jupiter_base_url.clone()),
        swap_slippage_bps: cfg.swap_slippage_bps,
    };

    for (i, ctx) in matches.iter().enumerate() {
        let pubkey = ctx.pubkey;

        // Re-evaluate the trigger condition between fires (skip for
        // the first one — the watcher just told us it holds — and for
        // linked-rule fires which already serialize through upstream
        // success).
        if i > 0 && depth == 0 {
            match revalidate::revalidate(&rev, ctx).await {
                Ok(true) => {}
                Ok(false) => {
                    info!(
                        automation = %pubkey,
                        correlation = %evt.correlation,
                        position = i,
                        "queue: condition no longer met, skipping later user"
                    );
                    continue;
                }
                Err(e) => {
                    // Network blip on revalidate — be conservative and
                    // pass through. On-chain check_can_fire still gates
                    // each ix.
                    debug!(
                        automation = %pubkey,
                        error = %e,
                        "queue: revalidate errored, passing through"
                    );
                }
            }
        }

        let claim_result = {
            let mut g = dedupe.lock().unwrap_or_else(|p| p.into_inner());
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

        let result = execute_one(
            &cfg,
            &http,
            &rpc,
            &config,
            ctx,
            depth,
            &blockhash_cache,
            &priority_fee_cache,
        )
        .await;
        match result {
            Ok(sig) => {
                dedupe
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .release_success(pubkey);
                info!(
                    automation = %pubkey,
                    correlation = %evt.correlation,
                    execute_sig = %sig,
                    position = i,
                    "executor: ix sent"
                );
            }
            Err(e) => {
                let msg = e.to_string();
                // Terminal-state errors all mean "this automation
                // shouldn't be retried for this trigger event."
                // AutomationFinished + DeadlineExpired are permanently
                // terminal; the keeper will also stop seeing the
                // account in the next indexer scan.
                let terminal = msg.contains("AutomationFinished")
                    || msg.contains("automationFinished")
                    || msg.contains("DeadlineExpired")
                    || msg.contains("deadlineExpired");
                let interval_not_elapsed = msg.contains("TimeIntervalNotElapsed")
                    || msg.contains("timeIntervalNotElapsed")
                    || msg.contains("MinIntervalNotElapsed")
                    || msg.contains("minIntervalNotElapsed");
                let skip_empty_ata = msg.contains("SkipEmptyUpstreamATA");
                dedupe
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .release_failure(pubkey, terminal);
                if terminal {
                    info!(
                        automation = %pubkey,
                        "executor: terminal state (Finished or DeadlineExpired) — stopping retries"
                    );
                } else if interval_not_elapsed {
                    debug!(
                        automation = %pubkey,
                        "executor: interval not elapsed yet — will retry next tick"
                    );
                } else if skip_empty_ata {
                    debug!(
                        automation = %pubkey,
                        "executor: upstream ATA empty, skipping fire until bridge lands"
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
    }
}

async fn execute_one(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    rpc: &RpcClient,
    config: &Pubkey,
    ctx: &AutomationCtx,
    depth: u8,
    blockhash_cache: &BlockhashCache,
    priority_fee_cache: &PriorityFeeCache,
) -> Result<String> {
    let exec_ix = build_action_ix(cfg, http, rpc, config, ctx).await?;

    // Resolve blockhash from cache; fall back to live RPC on cold start
    // (cache empty) or if the cached entry is more than 5 s old.
    let bh = match blockhash_cache.read().await {
        Some(c) if c.fetched_at.elapsed() < Duration::from_secs(5) => c,
        _ => {
            let (hash, last_valid_block_height) = rpc
                .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
                .await?;
            CachedBlockhash {
                hash,
                last_valid_block_height,
                fetched_at: std::time::Instant::now(),
            }
        }
    };

    let fee_microlamports_per_cu = priority_fee_cache.buffered(cfg.priority_fee_floor).await;

    let cu_limit = compute_unit_limit_for(&ctx.action);
    let mut ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(cu_limit),
        ComputeBudgetInstruction::set_compute_unit_price(fee_microlamports_per_cu),
    ];
    // For linked fires (depth > 0), atomically debit the per-fire fee
    // from the PDA's lamport pool BEFORE running the action. Tx
    // atomicity ensures both ixs land or both revert — no half-fired
    // fees. Standalone fires (depth == 0) are subsidized by the keeper
    // signer's main SOL balance.
    if depth > 0 {
        ixs.push(crate::program::build_execute_link_fee_debit_ix(
            &cfg.program_id,
            &cfg.keeper_pubkey,
            config,
            &ctx.pubkey,
            cfg.keeper_fee_lamports,
        ));
    }
    ixs.push(exec_ix);

    debug!(
        automation = %ctx.pubkey,
        action = ?ctx.action,
        priority_fee = fee_microlamports_per_cu,
        "executor: sending tx via helius sender"
    );

    let sig = send_with_one_shot_escalation(cfg, http, &ixs, &bh, fee_microlamports_per_cu).await?;
    Ok(sig)
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

/// Build, sign, and send one transaction attempt. Thin wrapper so
/// `send_with_one_shot_escalation` can call it twice with different fees.
/// Returns the raw signature string (base58), matching the contract of
/// `send_via_helius`.
async fn send_one(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    ixs: &[Instruction],
    bh: &CachedBlockhash,
    fee_microlamports_per_cu: u64,
) -> Result<String> {
    // Overwrite slot [1] with the caller-supplied fee. slot [0] is the
    // CU-limit ix and is not fee-related.
    let mut ixs_owned = ixs.to_vec();
    ixs_owned[1] = ComputeBudgetInstruction::set_compute_unit_price(fee_microlamports_per_cu);
    let tx = sign_tx(cfg.signer.as_ref(), &cfg.keeper_pubkey, &ixs_owned, bh.hash).await?;
    send_via_helius(http, &cfg.sender_url, &tx).await
}

/// Sends the transaction. On a retryable send error (blockhash not found,
/// transaction expired) escalates the priority fee to p95 once and retries.
/// No sustained escalation — the 5 s cache refresh raises the new baseline
/// naturally on the next fire.
async fn send_with_one_shot_escalation(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    ixs: &[Instruction],
    bh: &CachedBlockhash,
    base_fee_micro: u64,
) -> Result<String> {
    match send_one(cfg, http, ixs, bh, base_fee_micro).await {
        Ok(sig) => Ok(sig),
        Err(e) if is_retryable_send_error(&e) => {
            warn!(target: "executor", error = %e, "retrying with p95 priority fee");
            let escalated = fetch_p95_once(http, &cfg.rpc_url, &cfg.program_id)
                .await
                .unwrap_or(base_fee_micro * 2);
            send_one(cfg, http, ixs, bh, escalated).await
        }
        Err(e) => Err(e),
    }
}

async fn fetch_p95_once(
    http: &reqwest::Client,
    rpc_url: &str,
    program_id: &Pubkey,
) -> Option<u64> {
    let body = json!({
        "jsonrpc": "2.0",
        "id": "p95-escalation",
        "method": "getPriorityFeeEstimate",
        "params": [{ "accountKeys": [program_id.to_string()],
                     "options": { "priorityLevel": "veryHigh" } }],
    });
    http.post(rpc_url)
        .json(&body)
        .send()
        .await
        .ok()?
        .json::<Value>()
        .await
        .ok()?
        .get("result")
        .and_then(|r| r.get("priorityFeeEstimate"))
        .and_then(|f| f.as_f64())
        .map(|f| f as u64)
}

fn is_retryable_send_error(e: &anyhow::Error) -> bool {
    let s = format!("{e}").to_lowercase();
    s.contains("blockhash not found") || s.contains("transaction expired")
}

async fn build_action_ix(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    rpc: &RpcClient,
    config: &Pubkey,
    ctx: &AutomationCtx,
) -> Result<Instruction> {
    let program_id = &cfg.program_id;
    let keeper = &cfg.keeper_pubkey;
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
        ActionSpec::Swap {
            input_mint,
            output_mint,
            destination,
            amount_in,
            min_amount_out,
            linked_downstream,
            link_fee_deposit: _link_fee_deposit,
            consume_upstream_output,
        } => {
            // Build the swap ix off-chain via Jupiter's /build API,
            // then wrap it through Sotama's execute_swap relay so the
            // PDA signs the inner ix. The on-chain handler enforces:
            //   * input ATA mint = input_mint, owner = automation PDA
            //   * output ATA mint = output_mint, owner = destination
            //   * post-CPI output balance increase ≥ min_amount_out
            //   * the inner ix targets the canonical Jupiter v6 ID
            // We additionally sanity-check Jupiter's quoted out_amount
            // before submission so we don't spend gas on a quote we
            // already know will fail the on-chain slippage gate.
            let automation_input_ata = associated_token_address(&ctx.pubkey, input_mint);
            let destination_output_ata = associated_token_address(destination, output_mint);

            // When consume_upstream_output is set, the intended amount_in is
            // whatever the upstream rule deposited into this automation's
            // input ATA at fire time.  Query the live balance and use that
            // as the real swap amount.  If the ATA is empty the upstream
            // rule hasn't landed yet; skip silently rather than reverting.
            let effective_amount_in = if *consume_upstream_output {
                let balance = rpc
                    .get_token_account_balance(&automation_input_ata)
                    .await
                    .map_err(|e| anyhow!("get_token_account_balance failed: {e}"))?;
                let resolved: u64 = balance
                    .amount
                    .parse()
                    .map_err(|_| anyhow!("ATA balance not a u64"))?;
                if resolved == 0 {
                    // Nothing to fire on yet — upstream rule hasn't produced
                    // output or the bridge dispatcher hasn't landed.  Skip
                    // without spamming a revert.
                    tracing::debug!(
                        automation = %ctx.pubkey,
                        "skip fire: input ATA empty (consume_upstream_output=true)"
                    );
                    return Err(anyhow!("SkipEmptyUpstreamATA"));
                }
                resolved
            } else {
                *amount_in
            };

            let jup = JupiterClient::new(http.clone(), cfg.jupiter_base_url.clone());
            let build = jup
                .build_swap_cpi_safe(
                    input_mint,
                    output_mint,
                    effective_amount_in,
                    cfg.swap_slippage_bps,
                    &ctx.pubkey,
                )
                .await
                .map_err(|e| anyhow!("jupiter /build: {e}"))?;

            // Jupiter must return the canonical v6 program ID.
            let returned_program = Pubkey::from_str(&build.swap_instruction.program_id)
                .map_err(|e| anyhow!("bad programId from jupiter: {e}"))?;
            if returned_program != *jupiter_program_id() {
                return Err(anyhow!(
                    "jupiter /build returned wrong programId {returned_program}, expected {}",
                    jupiter_program_id()
                ));
            }

            // Cross-check quoted out_amount against the user's
            // min_amount_out so we don't pay gas on a guaranteed revert.
            let quoted_out: u64 = build
                .out_amount
                .parse()
                .map_err(|e| anyhow!("parse jupiter out_amount `{}`: {e}", build.out_amount))?;
            if quoted_out < *min_amount_out {
                return Err(anyhow!(
                    "jupiter quoted {} < min_amount_out {} — bailing before tx submit",
                    quoted_out,
                    min_amount_out
                ));
            }

            let inner_accounts = jupiter::into_account_metas(&build.swap_instruction.accounts)
                .map_err(|e| anyhow!("parse jupiter accounts: {e}"))?;
            if inner_accounts.len() > jupiter::MAX_CPI_ACCOUNTS as usize {
                return Err(anyhow!(
                    "jupiter route returned {} accounts; CPI budget is {}. Try a different pair or maxAccounts.",
                    inner_accounts.len(),
                    jupiter::MAX_CPI_ACCOUNTS
                ));
            }
            let inner_data = jupiter::decode_inner_data(&build.swap_instruction.data)?;
            let (input_idx, output_idx) = jupiter::locate_ata_indices(
                &inner_accounts,
                &automation_input_ata,
                &destination_output_ata,
            )?;

            Ok(build_execute_swap_ix(
                program_id,
                keeper,
                config,
                &ctx.pubkey,
                &inner_accounts,
                inner_data,
                input_idx,
                output_idx,
                linked_downstream.as_ref(),
            ))
        }
    }
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

/// Stable cross-user ordering used by `process_event`. Sorts by
/// `created_at` ascending so the oldest rule fires first, with `nonce`
/// as a tie-breaker for rules created in the same block. Pulled out
/// as a named helper purely so the ordering invariant is unit-testable.
pub(crate) fn sort_matches_for_queue(matches: &mut Vec<AutomationCtx>) {
    matches.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.nonce.cmp(&b.nonce)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caches::priority_fee::PriorityFeeCache;
    use crate::state::{ActionSpec, TriggerSpec};

    fn ctx(pubkey_seed: u8, owner_seed: u8, nonce: u64, created_at: i64) -> AutomationCtx {
        AutomationCtx {
            pubkey: Pubkey::new_from_array([pubkey_seed; 32]),
            owner: Pubkey::new_from_array([owner_seed; 32]),
            nonce,
            created_at,
            // Trigger / action shape doesn't matter for the sort test —
            // any deterministic variant is fine.
            trigger: TriggerSpec::AccountActivity {
                account: Pubkey::default(),
                mint: None,
                kind: 0,
            },
            action: ActionSpec::TransferSol {
                destination: Pubkey::default(),
                amount: 0,
            },
            bridge_enabled: false,
        }
    }

    #[test]
    fn sorts_by_created_at_then_nonce() {
        // Three rules: oldest is C (created_at=100), middle is A (200),
        // newest is B (300). Order by created_at ascending.
        let a = ctx(0xAA, 1, 1, 200);
        let b = ctx(0xBB, 2, 2, 300);
        let c = ctx(0xCC, 3, 3, 100);
        let mut v = vec![a.clone(), b.clone(), c.clone()];
        sort_matches_for_queue(&mut v);
        assert_eq!(v[0].pubkey, c.pubkey, "oldest first");
        assert_eq!(v[1].pubkey, a.pubkey);
        assert_eq!(v[2].pubkey, b.pubkey);
    }

    #[test]
    fn nonce_breaks_ties_on_equal_created_at() {
        // Two rules created in the same block: lower nonce fires first.
        let earlier = ctx(0xDD, 1, 5, 1_000);
        let later = ctx(0xEE, 2, 9, 1_000);
        let mut v = vec![later.clone(), earlier.clone()];
        sort_matches_for_queue(&mut v);
        assert_eq!(v[0].pubkey, earlier.pubkey, "lower nonce wins on tie");
        assert_eq!(v[1].pubkey, later.pubkey);
    }

    #[tokio::test]
    async fn buffered_fee_floor_used_when_cache_empty() {
        let cache = PriorityFeeCache::new();
        assert_eq!(cache.buffered(42).await, 42);
    }
}
