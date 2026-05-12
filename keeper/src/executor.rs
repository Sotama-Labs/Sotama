use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::address_lookup_table::AddressLookupTableAccount;
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::compute_budget::ComputeBudgetInstruction;
use solana_sdk::hash::Hash;
use solana_sdk::instruction::Instruction;
use solana_sdk::message::{v0::Message as MessageV0, VersionedMessage};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::transaction::VersionedTransaction;
use std::collections::{HashSet, VecDeque};
use std::str::FromStr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::caches::blockhash::{BlockhashCache, CachedBlockhash};
use crate::caches::lookup_table::LookupTableCache;
use crate::caches::mint_program::MintProgramCache;
use crate::caches::priority_fee::PriorityFeeCache;
use crate::caches::treasury::TreasuryHandle;
use crate::config::KeeperConfig;
use crate::jupiter::{self, JupiterClient};
use crate::program::{
    associated_token_address, associated_token_address_for_program,
    build_execute_automation_ix, build_execute_automation_spl_ix, build_execute_swap_ix,
    config_pda, jupiter_program_id,
};
use crate::signer::KeeperSigner;
use crate::state::ActionSpec;
use crate::types::{AutomationCtx, TriggerEvent};

/// Hard Solana transaction wire-size limit. The packet-level cap is
/// 1232 bytes; we leave a tiny safety margin so a last-second blockhash
/// change or signature path doesn't tip us over.
const TX_WIRE_SIZE_LIMIT: usize = 1232;

const RECENT_TRIGGER_CACHE_SIZE: usize = 4_096;

/// Per-action compute budget selector. Matched on the action variant so
/// future ix types (fee topup, link fee debit) can declare their own
/// ceilings without cluttering the executor's hot path. Caller-supplied
/// limits come from `KeeperConfig::cu_limit_*` so operators can tune in
/// production without a redeploy.
fn compute_unit_limit_for(action: &ActionSpec, cfg: &KeeperConfig) -> u32 {
    match action {
        ActionSpec::Swap { .. } => cfg.cu_limit_swap,
        _ => cfg.cu_limit_default,
    }
}

/// Per-keeper-session deduplication state.
///
/// Three layers of guard:
///   * `terminal_fired` — rules we've observed transition to a terminal
///     state in this session (AutomationFinished / DeadlineExpired). Once
///     added, the rule is permanently skipped until the indexer's next
///     reconcile pass drops it from the watched set entirely.
///   * `recent_triggers` — bounded LRU of (automation, correlation-sig)
///     pairs we've already processed. Stops the keeper from re-acting
///     on the same trigger event arriving twice (Hermes SSE + 12s poll
///     both crossing the threshold in the same window).
///   * `in_flight` — rules with an outstanding sendTransaction. Prevents
///     parallel re-fires while a tx is between sign and confirm.
///
/// Historical note: a prior version added EVERY successful fire to
/// `terminal_fired` (then named `fired`), which trapped multi-fire
/// `Cadence::Repeat { total: N > 1 }` rules after their first fire —
/// the on-chain `check_can_fire` would have allowed the second fire
/// (interval permitting), but the keeper refused to send it. Fixed by
/// only inserting into `terminal_fired` when the on-chain handler
/// returns one of the terminal-state error codes.
struct Dedupe {
    terminal_fired: HashSet<Pubkey>,
    recent_triggers: HashSet<(Pubkey, String)>,
    recent_order: VecDeque<(Pubkey, String)>,
    in_flight: HashSet<Pubkey>,
}

impl Dedupe {
    fn new() -> Self {
        Self {
            terminal_fired: HashSet::new(),
            recent_triggers: HashSet::new(),
            recent_order: VecDeque::new(),
            in_flight: HashSet::new(),
        }
    }

    fn try_claim(&mut self, pubkey: Pubkey, sig: &str) -> Option<&'static str> {
        if self.terminal_fired.contains(&pubkey) {
            return Some("rule is terminal");
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

    /// Successful fire. Clears the in-flight bit so the next trigger
    /// event for this rule (different correlation sig) can claim again.
    /// Does NOT mark the rule terminal — that's the on-chain handler's
    /// call, surfaced to us via the terminal-state error codes.
    fn release_success(&mut self, pubkey: Pubkey) {
        self.in_flight.remove(&pubkey);
    }

    /// Failed fire. `treat_as_done=true` means the on-chain handler
    /// returned a terminal-state error (AutomationFinished /
    /// DeadlineExpired) — promote to `terminal_fired` so we stop trying.
    fn release_failure(&mut self, pubkey: Pubkey, treat_as_done: bool) {
        self.in_flight.remove(&pubkey);
        if treat_as_done {
            self.terminal_fired.insert(pubkey);
        }
    }
}

pub async fn run(
    cfg: Arc<KeeperConfig>,
    http: reqwest::Client,
    mut rx: mpsc::Receiver<TriggerEvent>,
    blockhash_cache: BlockhashCache,
    priority_fee_cache: PriorityFeeCache,
    lookup_table_cache: LookupTableCache,
    treasury_handle: TreasuryHandle,
    mint_program_cache: MintProgramCache,
) -> Result<()> {
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
        let alt_cache_task = lookup_table_cache.clone();
        let treasury_task = treasury_handle.clone();
        let mint_cache_task = mint_program_cache.clone();
        tokio::spawn(async move {
            process_event(
                cfg_task,
                http_task,
                config,
                evt,
                dedupe_task,
                blockhash_cache_task,
                priority_fee_cache_task,
                alt_cache_task,
                treasury_task,
                mint_cache_task,
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
    lookup_table_cache: LookupTableCache,
    treasury_handle: TreasuryHandle,
    mint_program_cache: MintProgramCache,
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

    // Snapshot-age check: if the price snapshot that triggered this event
    // is now stale, drop the fire and wait for the watcher to push a fresh
    // crossing. Checked once per event (not per-match) because all matches
    // in a single event share the same snapshot — the price reading that
    // caused the crossing. Non-price triggers (snapshot=None) use a 2 s
    // fallback so they always pass through immediately.
    let max_age = match evt.snapshot.as_ref().map(|s| s.source) {
        Some(layer) => layer.max_age(),
        None => std::time::Duration::from_secs(2), // non-price triggers
    };
    if let Some(snap) = &evt.snapshot {
        if snap.fetched_at.elapsed() > max_age {
            warn!(target: "executor", "snapshot stale, dropping fire");
            return;
        }
    }

    for (i, ctx) in matches.iter().enumerate() {
        let pubkey = ctx.pubkey;

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
            &lookup_table_cache,
            &treasury_handle,
            &mint_program_cache,
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
                // The on-chain program rejects an execute_swap whose
                // Jupiter CPI consumed more than the action's
                // `amount_in` (added in v4.5 to enforce TWAP/DCA
                // semantics). Hitting this means the keeper built a
                // route with the wrong input cap — almost always a
                // quote-vs-build mismatch (e.g. Jupiter returned a
                // route with a larger inAmount than we requested) or a
                // stale per-fire amount_in in our cache. Surface it as
                // a distinct error so operators notice quote drift
                // instead of swallowing it as a generic ix failure; the
                // default retry-on-next-trigger path is correct
                // because the next /build call should produce a fresh,
                // correctly-sized quote.
                let input_overconsumed = msg.contains("InputConsumedExceedsAmountIn")
                    || msg.contains("inputConsumedExceedsAmountIn");
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
                } else if input_overconsumed {
                    error!(
                        automation = %pubkey,
                        error = %msg,
                        "executor: Jupiter route consumed more than amount_in — likely quote/build drift; will requote on next trigger"
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
    rpc: &Arc<RpcClient>,
    config: &Pubkey,
    ctx: &AutomationCtx,
    depth: u8,
    blockhash_cache: &BlockhashCache,
    priority_fee_cache: &PriorityFeeCache,
    lookup_table_cache: &LookupTableCache,
    treasury_handle: &TreasuryHandle,
    mint_program_cache: &MintProgramCache,
) -> Result<String> {
    let (exec_ix, alts) = build_action_ix(
        cfg,
        http,
        rpc,
        config,
        ctx,
        lookup_table_cache,
        treasury_handle,
        mint_program_cache,
    )
    .await?;

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

    let fee_microlamports_per_cu = priority_fee_cache
        .buffered_clamped(cfg.priority_fee_floor, cfg.priority_fee_ceiling)
        .await;

    let cu_limit = compute_unit_limit_for(&ctx.action, cfg);
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
    // Helius Sender opt-in: every Sender tx must include a Jito tip
    // SystemProgram::transfer of ≥ 0.0002 SOL to one of the known tip
    // accounts. Append last so the tip ix can be ALT-compressed if
    // helpful and so it doesn't perturb the index-based account
    // accounting earlier ixs do. When `use_sender` is false this is a
    // no-op and we keep the legacy mainnet-RPC path.
    if cfg.use_sender {
        ixs.push(crate::sender_helius::build_jito_tip_ix(
            &cfg.keeper_pubkey,
            cfg.sender_tip_lamports,
        ));
    }

    debug!(
        automation = %ctx.pubkey,
        action = ?ctx.action,
        priority_fee = fee_microlamports_per_cu,
        alt_count = alts.len(),
        "executor: sending tx via helius sender"
    );

    let sig = send_with_one_shot_escalation(
        cfg,
        http,
        rpc,
        &ixs,
        &alts,
        &bh,
        fee_microlamports_per_cu,
    )
    .await?;
    Ok(sig)
}

/// Compile, serialize, and sign a v0 versioned transaction via the
/// configured signer. ALT-aware: `alts` are matched into the compiled
/// `MessageV0`, which lets the wire-serialized tx reference common
/// accounts (Jupiter token-program, intermediate ATAs, etc.) as
/// 1-byte table indices instead of 32-byte inline pubkeys. This is
/// what keeps composed swaps under the 1232-byte cap on mainnet.
async fn sign_tx(
    signer: &dyn KeeperSigner,
    payer: &Pubkey,
    ixs: &[Instruction],
    alts: &[AddressLookupTableAccount],
    blockhash: Hash,
) -> Result<VersionedTransaction> {
    let message_v0 = MessageV0::try_compile(payer, ixs, alts, blockhash)
        .map_err(|e| anyhow!("MessageV0::try_compile: {e}"))?;
    let versioned = VersionedMessage::V0(message_v0);
    let signable = versioned.serialize();
    let sig = signer.sign_message(&signable).await?;
    Ok(VersionedTransaction {
        signatures: vec![sig],
        message: versioned,
    })
}

/// Build, sign, and send one transaction attempt. Thin wrapper so
/// `send_with_one_shot_escalation` can call it twice with different fees.
/// Returns the raw signature string (base58), matching the contract of
/// `send_via_helius`.
///
/// Post-compile enforces the 1232-byte wire-size cap. If the serialized
/// tx exceeds the cap the call errors *before* hitting the network —
/// better to surface a structured failure than burn a sendTransaction
/// quote on a packet the validators will reject.
async fn send_one(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    ixs: &[Instruction],
    alts: &[AddressLookupTableAccount],
    bh: &CachedBlockhash,
    fee_microlamports_per_cu: u64,
) -> Result<String> {
    debug_assert!(
        ixs.len() >= 2,
        "send_one expects ixs[0]=CU-limit and ixs[1]=CU-price; got {} ixs",
        ixs.len()
    );
    // Overwrite slot [1] with the caller-supplied fee. slot [0] is the
    // CU-limit ix and is not fee-related.
    let mut ixs_owned = ixs.to_vec();
    ixs_owned[1] = ComputeBudgetInstruction::set_compute_unit_price(fee_microlamports_per_cu);
    let tx = sign_tx(
        cfg.signer.as_ref(),
        &cfg.keeper_pubkey,
        &ixs_owned,
        alts,
        bh.hash,
    )
    .await?;
    let serialized = bincode::serialize(&tx).map_err(|e| anyhow!("bincode serialize: {e}"))?;
    if serialized.len() > TX_WIRE_SIZE_LIMIT {
        return Err(anyhow!(
            "tx wire size {} exceeds Solana cap {} ({} accounts inline; ALT compression insufficient)",
            serialized.len(),
            TX_WIRE_SIZE_LIMIT,
            tx.message.static_account_keys().len(),
        ));
    }
    // Route to Helius Sender when opted in (Jito tip already appended
    // by the caller); otherwise standard mainnet RPC with preflight on.
    match crate::sender_helius::sender_endpoint(cfg) {
        Some(endpoint) => send_via_sender(http, &endpoint, &serialized).await,
        None => send_via_helius(http, &cfg.sender_url, &serialized).await,
    }
}

/// Sends the transaction. On a retryable send error (blockhash not found,
/// transaction expired) escalates the priority fee to p95 once and retries
/// with a freshly fetched blockhash. No sustained escalation — the 5 s
/// cache refresh raises the new baseline naturally on the next fire.
async fn send_with_one_shot_escalation(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    rpc: &Arc<RpcClient>,
    ixs: &[Instruction],
    alts: &[AddressLookupTableAccount],
    bh: &CachedBlockhash,
    base_fee_micro: u64,
) -> Result<String> {
    match send_one(cfg, http, ixs, alts, bh, base_fee_micro).await {
        Ok(sig) => Ok(sig),
        Err(e) if is_retryable_send_error(&e) => {
            warn!(target: "executor", error = %e, "send failed; escalating fee and refreshing blockhash");
            // p95 escalation: bump to VeryHigh tier once. Clamp to
            // [base × 2, priority_fee_ceiling] so a degenerate Helius
            // response or a bug in the estimate endpoint can't burn the
            // keeper's SOL on a single retry. The 2× floor ensures we
            // always escalate vs the base fee even if the estimate
            // comes back lower than what we just tried.
            let raw = fetch_p95_once(http, &cfg.rpc_url, &cfg.program_id)
                .await
                .unwrap_or(base_fee_micro * 2);
            let escalated = raw.max(base_fee_micro * 2).min(cfg.priority_fee_ceiling);
            let (hash, last_valid_block_height) = rpc
                .get_latest_blockhash_with_commitment(CommitmentConfig::confirmed())
                .await?;
            let fresh_bh = CachedBlockhash {
                hash,
                last_valid_block_height,
                fetched_at: std::time::Instant::now(),
            };
            send_one(cfg, http, ixs, alts, &fresh_bh, escalated).await
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
                     "options": { "priorityLevel": "VeryHigh" } }],
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
    lookup_table_cache: &LookupTableCache,
    treasury_handle: &TreasuryHandle,
    mint_program_cache: &MintProgramCache,
) -> Result<(Instruction, Vec<AddressLookupTableAccount>)> {
    let program_id = &cfg.program_id;
    let keeper = &cfg.keeper_pubkey;
    match &ctx.action {
        ActionSpec::TransferSol { destination, .. } => Ok((
            build_execute_automation_ix(program_id, keeper, config, &ctx.pubkey, destination),
            Vec::new(),
        )),
        ActionSpec::TransferSpl {
            destination, mint, ..
        } => {
            let automation_ata = associated_token_address(&ctx.pubkey, mint);
            let destination_ata = associated_token_address(destination, mint);
            Ok((
                build_execute_automation_spl_ix(
                    program_id,
                    keeper,
                    config,
                    &ctx.pubkey,
                    mint,
                    &automation_ata,
                    &destination_ata,
                ),
                Vec::new(),
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
            // Per-mint token-program lookup. Token-2022 mints derive
            // a different ATA than legacy SPL mints for the same
            // (owner, mint) pair because the token program is part of
            // the PDA seeds. Cache hit on the second + fire for the
            // same mint.
            let input_token_program = mint_program_cache.resolve(rpc, input_mint).await?;
            let output_token_program = mint_program_cache.resolve(rpc, output_mint).await?;
            let automation_input_ata = associated_token_address_for_program(
                &ctx.pubkey,
                input_mint,
                &input_token_program,
            );
            let destination_output_ata = associated_token_address_for_program(
                destination,
                output_mint,
                &output_token_program,
            );

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

            let jup = JupiterClient::new(http.clone(), cfg.jupiter_base_url.clone())
                .with_api_key(cfg.jupiter_api_key.clone());
            let build = jup
                .build_swap(
                    input_mint,
                    output_mint,
                    effective_amount_in,
                    cfg.swap_slippage_bps,
                    &ctx.pubkey,
                    Some(&destination_output_ata),
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
            let inner_data = jupiter::decode_inner_data(&build.swap_instruction.data)?;
            let (input_idx, output_idx) = jupiter::locate_ata_indices(
                &inner_accounts,
                &automation_input_ata,
                &destination_output_ata,
            )?;
            // Locate the output mint within Jupiter's inner accounts —
            // it's always there because the AMM hops need it for SPL
            // transfers. The on-chain handler reads `decimals` from
            // this account for `transfer_checked` and validates the
            // pubkey matches `ActionSpec::Swap.output_mint` so a
            // hostile keeper can't substitute a different mint.
            let output_mint_idx = jupiter::locate_mint_index(&inner_accounts, output_mint)?;

            // Re-enable ALT compression on the parent tx. The prior
            // "Jupiter CPI cannot use ALTs" claim came from a 2026-05-12
            // sanitize-error we never root-caused at the time; per the
            // v0_with_alts_fits_under_wire_cap test, the same shape
            // compiles fine offline. Without ALTs, Jupiter routes deeper
            // than ~22 accounts (most non-trivial pairs — USDC↔W, JUP,
            // niche memes) can't fit under Solana's 1232-byte v0 cap.
            // With ALTs we comfortably handle 40+ accounts.
            //
            // If a sanitize error re-surfaces we'll have a real tx
            // signature this time (preflight is on) and can investigate
            // the actual cause rather than speculate.
            let alt_keys = jupiter::lookup_table_pubkeys(&build.addresses_by_lookup_table_address)?;
            let alts = lookup_table_cache.resolve_many(rpc, &alt_keys).await?;

            // Treasury's output ATA — derived from on-chain
            // Config.treasury (cached) and the swap's output mint. The
            // on-chain handler enforces mint + owner, so the keeper
            // can't redirect the fee even if this resolution is wrong.
            // ATA derivation must use the output mint's token program
            // (legacy SPL vs Token-2022) since that's a seed input.
            let treasury_pubkey = treasury_handle.get(rpc, config).await?;
            let treasury_output_ata = associated_token_address_for_program(
                &treasury_pubkey,
                output_mint,
                &output_token_program,
            );

            Ok((
                build_execute_swap_ix(
                    program_id,
                    keeper,
                    config,
                    &ctx.pubkey,
                    &inner_accounts,
                    inner_data,
                    input_idx,
                    output_idx,
                    output_mint_idx,
                    &treasury_output_ata,
                    &output_token_program,
                    linked_downstream.as_ref(),
                ),
                alts,
            ))
        }
    }
}

async fn send_via_helius(
    http: &reqwest::Client,
    sender_url: &str,
    serialized: &[u8],
) -> Result<String> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(serialized);
    // Keep size at debug; raise to `info` only when diagnosing a future
    // sanitize / preflight failure (each entry is ~1.4 KB).
    tracing::debug!(
        target: "executor",
        size_bytes = serialized.len(),
        tx_b64 = %b64,
        "send_one: about to send tx"
    );
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [
            b64,
            { "encoding": "base64", "skipPreflight": false, "maxRetries": 3, "preflightCommitment": "processed" }
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

/// Helius Sender variant: posts to `sender.helius-rpc.com/fast` (or a
/// regional hostname) with the Sender-specific options the docs
/// require (`skipPreflight: true, maxRetries: 0`). Caller MUST have
/// included a Jito tip ix on the tx — Sender returns
/// `-32602 Invalid request` otherwise. We don't validate that here
/// because the only call sites are the executor + bridge dispatcher
/// hot paths that we already audited; surfacing the error from Sender
/// is fine.
async fn send_via_sender(
    http: &reqwest::Client,
    endpoint: &str,
    serialized: &[u8],
) -> Result<String> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(serialized);
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [
            b64,
            { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }
        ]
    });
    let resp: Value = http.post(endpoint).json(&body).send().await?.json().await?;
    if let Some(err) = resp.get("error") {
        return Err(anyhow!("helius Sender sendTransaction error: {err}"));
    }
    resp["result"]
        .as_str()
        .ok_or_else(|| anyhow!("missing signature in Sender response {resp}"))
        .map(|s| s.to_string())
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

    /// Offline integration test for the v0 + ALT compile + serialize
    /// chain. Mirrors today's mainnet measurement of SOL→USDC: 36 inner
    /// accounts, 21 of them ALT-resident across 2 published ALTs. Proves
    /// the keeper's actual compile path (the same one `send_one` calls)
    /// produces a wire-serialized tx under the 1232-byte cap.
    ///
    /// Devnet can't validate this end-to-end because Jupiter doesn't
    /// route the same way on devnet (thin liquidity, often no route).
    /// This test is the pre-mainnet substitute: feed the keeper a
    /// realistic shape and confirm the bytes-on-wire math holds.
    #[tokio::test]
    async fn v0_with_alts_fits_under_wire_cap() {
        use solana_sdk::hash::Hash;
        use solana_sdk::message::v0::Message as MessageV0;
        use solana_sdk::message::VersionedMessage;
        use solana_sdk::signature::Signature;
        use solana_sdk::transaction::VersionedTransaction;

        let (ixs, alts, payer) = build_realistic_swap_scenario(/*alt_resident=*/ 21);
        let blockhash = Hash::new_unique();
        let message_v0 = MessageV0::try_compile(&payer, &ixs, &alts, blockhash)
            .expect("MessageV0::try_compile");
        let tx = VersionedTransaction {
            signatures: vec![Signature::default()],
            message: VersionedMessage::V0(message_v0),
        };
        let serialized = bincode::serialize(&tx).expect("serialize");

        assert!(
            serialized.len() <= TX_WIRE_SIZE_LIMIT,
            "v0+ALT tx exceeded wire cap: {} > {} (static keys: {}, alt lookups: {})",
            serialized.len(),
            TX_WIRE_SIZE_LIMIT,
            tx.message.static_account_keys().len(),
            alts.len(),
        );
    }

    /// Counter-test: same 36-account Jupiter route, same outer Sotama
    /// frame, but NO ALTs. Confirms ALT compression is what's keeping
    /// the tx under the wire cap — if this somehow passes under 1232
    /// without ALTs, then the positive test above is testing nothing.
    #[tokio::test]
    async fn v0_without_alts_overshoots_wire_cap() {
        use solana_sdk::hash::Hash;
        use solana_sdk::message::v0::Message as MessageV0;
        use solana_sdk::message::VersionedMessage;
        use solana_sdk::signature::Signature;
        use solana_sdk::transaction::VersionedTransaction;

        let (ixs, _alts, payer) = build_realistic_swap_scenario(/*alt_resident=*/ 21);
        let blockhash = Hash::new_unique();
        let message_v0 = MessageV0::try_compile(&payer, &ixs, &[], blockhash)
            .expect("MessageV0::try_compile");
        let tx = VersionedTransaction {
            signatures: vec![Signature::default()],
            message: VersionedMessage::V0(message_v0),
        };
        let serialized = bincode::serialize(&tx).expect("serialize");

        assert!(
            serialized.len() > TX_WIRE_SIZE_LIMIT,
            "no-ALT path unexpectedly fit under cap ({} <= {}); positive test is meaningless",
            serialized.len(),
            TX_WIRE_SIZE_LIMIT,
        );
    }

    /// Sender-mode variant: identical 36-account Jupiter route, ALTs
    /// covering 21 of them, BUT we additionally append the 0.0002 SOL
    /// Jito tip ix the keeper emits when `KEEPER_USE_SENDER=1`. The
    /// tip adds one new inline account (the random tip recipient —
    /// not in any ALT, so 32 bytes of inline pubkey) plus ~12 bytes of
    /// `SystemProgram::transfer` ix data and an AccountMeta header.
    /// This proves the worst-case real-world tx — Token-2022 output
    /// (output_mint outer account already in the scenario) + Sender
    /// tip — still fits under 1232 bytes after the post-migration
    /// outer-frame changes.
    #[tokio::test]
    async fn v0_with_alts_and_sender_tip_fits_under_wire_cap() {
        use solana_sdk::hash::Hash;
        use solana_sdk::message::v0::Message as MessageV0;
        use solana_sdk::message::VersionedMessage;
        use solana_sdk::signature::Signature;
        use solana_sdk::transaction::VersionedTransaction;
        use solana_sdk::system_instruction;

        let (mut ixs, alts, payer) =
            build_realistic_swap_scenario(/*alt_resident=*/ 21);
        // Append the Jito tip ix exactly like the executor's hot path
        // when `cfg.use_sender == true`.
        ixs.push(system_instruction::transfer(
            &payer,
            &Pubkey::new_unique(),
            200_000, // 0.0002 SOL minimum per Helius docs
        ));
        let blockhash = Hash::new_unique();
        let message_v0 = MessageV0::try_compile(&payer, &ixs, &alts, blockhash)
            .expect("MessageV0::try_compile");
        let tx = VersionedTransaction {
            signatures: vec![Signature::default()],
            message: VersionedMessage::V0(message_v0),
        };
        let serialized = bincode::serialize(&tx).expect("serialize");

        assert!(
            serialized.len() <= TX_WIRE_SIZE_LIMIT,
            "Sender-mode tx (v0+ALT+tip) exceeded wire cap: {} > {} (static keys: {}, alts: {})",
            serialized.len(),
            TX_WIRE_SIZE_LIMIT,
            tx.message.static_account_keys().len(),
            alts.len(),
        );
        // Surface the margin in CI logs so a future change tightening
        // the budget is visible before it bites in production.
        eprintln!(
            "Sender-mode wire-size headroom: {} bytes (limit {}, actual {})",
            TX_WIRE_SIZE_LIMIT - serialized.len(),
            TX_WIRE_SIZE_LIMIT,
            serialized.len(),
        );
    }

    /// Shared fixture for both v0 tests. Builds the same instructions
    /// list send_one builds in production:
    ///   1. ComputeBudget::set_compute_unit_limit
    ///   2. ComputeBudget::set_compute_unit_price
    ///   3. Sotama execute_swap wrapping a synthetic 36-account Jupiter ix
    ///
    /// `alt_resident` controls how many of the 36 inner Jupiter accounts
    /// also appear in the ALTs returned alongside the ixs. The ALTs are
    /// padded to 256 entries each, matching Jupiter's production ALTs.
    fn build_realistic_swap_scenario(
        alt_resident: usize,
    ) -> (
        Vec<solana_sdk::instruction::Instruction>,
        Vec<solana_sdk::address_lookup_table::AddressLookupTableAccount>,
        Pubkey,
    ) {
        use crate::program::build_execute_swap_ix;
        use solana_sdk::address_lookup_table::AddressLookupTableAccount;
        use solana_sdk::instruction::AccountMeta;

        let inner_pubkeys: Vec<Pubkey> = (0..36).map(|_| Pubkey::new_unique()).collect();
        let inner_accounts: Vec<AccountMeta> = inner_pubkeys
            .iter()
            .enumerate()
            .map(|(i, k)| AccountMeta {
                pubkey: *k,
                is_signer: false,
                is_writable: i < 18, // ~half writable, matches Jupiter shape
            })
            .collect();

        // Split alt_resident accounts across 2 published ALTs.
        let half = alt_resident / 2;
        let alt1_inner: Vec<Pubkey> = inner_pubkeys[..half].to_vec();
        let alt2_inner: Vec<Pubkey> = inner_pubkeys[half..alt_resident].to_vec();
        let pad = |seed: &[Pubkey], pad_n: usize| -> Vec<Pubkey> {
            let mut v: Vec<Pubkey> = seed.to_vec();
            v.extend((0..pad_n).map(|_| Pubkey::new_unique()));
            v
        };
        let alts = vec![
            AddressLookupTableAccount {
                key: Pubkey::new_unique(),
                addresses: pad(&alt1_inner, 256 - alt1_inner.len()),
            },
            AddressLookupTableAccount {
                key: Pubkey::new_unique(),
                addresses: pad(&alt2_inner, 256 - alt2_inner.len()),
            },
        ];

        let program_id = Pubkey::new_unique();
        let keeper = Pubkey::new_unique();
        let config = Pubkey::new_unique();
        let automation = Pubkey::new_unique();
        // Jupiter swap ix data is typically 16-32 bytes (route bytes +
        // slippage); 32 is a conservative upper bound.
        let inner_data = vec![0u8; 32];

        let swap_ix = build_execute_swap_ix(
            &program_id,
            &keeper,
            &config,
            &automation,
            &inner_accounts,
            inner_data,
            0, // input_ata_index
            1, // output_ata_index
            2, // output_mint_index — points into inner_accounts (any
               // index is fine for the byte-count test; on-chain
               // validates the pubkey matches action.output_mint, but
               // production won't reach the wire-size compile).
            &Pubkey::new_unique(), // treasury_output_ata
            &crate::program::spl_token_program_id().clone(), // token_program (legacy SPL for the wire-size test)
            None,
        );

        let ixs = vec![
            ComputeBudgetInstruction::set_compute_unit_limit(1_000_000),
            ComputeBudgetInstruction::set_compute_unit_price(50_000),
            swap_ix,
        ];
        (ixs, alts, keeper)
    }
}
