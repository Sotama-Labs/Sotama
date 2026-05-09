//! Keeper-side bridge dispatcher.
//!
//! Polls the indexer's WatchedSet every `cfg.bridge_scan_interval` and,
//! for each automation with `bridge_enabled = true`, scans the PDA's
//! token accounts. Any non-input-mint balance above the dust floor is
//! converted back into the canonical input mint via Jupiter, relayed
//! through the on-chain `execute_bridge` handler so the PDA signs the
//! inner Jupiter ix.
//!
//! Why this exists: linked-rule chains can leave the PDA holding the
//! WRONG mint (e.g. an arb sells SOL→USDC on the upstream leg, then the
//! downstream leg wants to sell USDC→USDT, but the price moved and the
//! second leg never crosses). The dispatcher unwinds those orphaned
//! balances back to the input mint so the next fire still has buying
//! power. The on-chain handler enforces:
//!   • output ATA mint == input_mint, owner == automation PDA
//!   • post-CPI output balance increase ≥ min_amount_out
//!   • inner ix targets the canonical Jupiter v6 program
//!
//! Trust model is the same as `execute_swap`: the keeper picks the
//! amount and the route, on-chain enforces the destination shape and
//! the slippage floor.

use anyhow::{anyhow, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_request::TokenAccountsFilter;
use solana_sdk::{
    commitment_config::CommitmentConfig, compute_budget::ComputeBudgetInstruction, hash::Hash,
    instruction::Instruction, message::Message, pubkey::Pubkey, transaction::Transaction,
};
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::watch;
use tokio::time::{interval, MissedTickBehavior};
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;
use crate::jupiter::{self, JupiterClient};
use crate::program::{
    associated_token_address, build_execute_bridge_ix, config_pda, jupiter_program_id,
    spl_token_program_id,
};
use crate::signer::KeeperSigner;
use crate::state::ActionSpec;
use crate::types::AutomationCtx;

/// Compute-unit ceiling for `execute_bridge`. Same as a normal swap —
/// the relayed Jupiter route is the dominant cost and 1M is the same
/// upper bound the executor uses for `execute_swap`.
const COMPUTE_UNIT_LIMIT_BRIDGE: u32 = 1_000_000;
/// Default priority fee. Re-tuned per-tx against the Helius estimator
/// in `executor.rs`; kept identical here so dispatcher fires don't
/// silently underpay the cluster.
const PRIORITY_FEE_DEFAULT_MICROLAMPORTS: u64 = 50_000;

pub async fn run(cfg: Arc<KeeperConfig>, set_rx: watch::Receiver<WatchedSet>) -> Result<()> {
    info!(
        interval_secs = cfg.bridge_scan_interval.as_secs(),
        min_balance = cfg.bridge_min_balance,
        slippage_bps = cfg.bridge_slippage_bps,
        "bridge_dispatcher starting"
    );

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()?;
    let rpc = Arc::new(RpcClient::new_with_commitment(
        cfg.rpc_url.clone(),
        CommitmentConfig::confirmed(),
    ));
    let jup = JupiterClient::new(http.clone(), cfg.jupiter_base_url.clone());
    let config = config_pda(&cfg.program_id);

    let mut tick = interval(cfg.bridge_scan_interval);
    tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // Burn the immediate first tick so the indexer has a chance to seed
    // before our first scan — same pattern as `indexer::run`.
    tick.tick().await;

    loop {
        tick.tick().await;
        let set = set_rx.borrow().clone();
        let candidates: Vec<AutomationCtx> = set
            .by_pubkey
            .values()
            .filter(|c| c.bridge_enabled)
            .cloned()
            .collect();
        if candidates.is_empty() {
            debug!("bridge_dispatcher: no bridge_enabled automations");
            continue;
        }

        debug!(count = candidates.len(), "bridge_dispatcher: scanning PDAs");
        for ctx in candidates {
            if let Err(e) = scan_pda(&cfg, &http, &rpc, &jup, &config, &ctx).await {
                warn!(automation = %ctx.pubkey, error = %e, "bridge_dispatcher: scan_pda failed");
            }
        }
    }
}

async fn scan_pda(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    rpc: &RpcClient,
    jup: &JupiterClient,
    config: &Pubkey,
    ctx: &AutomationCtx,
) -> Result<()> {
    // Bridge only makes sense for Swap actions — that's where there's a
    // canonical "input mint" to converge on. A non-Swap automation with
    // `bridge_enabled` shouldn't exist (the on-chain validator rejects
    // it on create), but we double-check rather than panic.
    let input_mint = match &ctx.action {
        ActionSpec::Swap { input_mint, .. } => *input_mint,
        _ => {
            debug!(automation = %ctx.pubkey, "bridge_enabled on non-Swap action, skipping");
            return Ok(());
        }
    };

    // Filter to legacy SPL Token at the RPC layer. This drops Token-2022
    // accounts entirely — Jupiter's v6 program doesn't sign for the 2022
    // program, and our on-chain handler hard-codes spl_token. Cheaper
    // than fetching every owner account and filtering client-side.
    let token_program = *spl_token_program_id();
    let accounts = rpc
        .get_token_accounts_by_owner(&ctx.pubkey, TokenAccountsFilter::ProgramId(token_program))
        .await
        .map_err(|e| anyhow!("get_token_accounts_by_owner: {e}"))?;

    for acct in accounts {
        let parsed = match parse_token_account(&acct.account.data) {
            Some(p) => p,
            None => continue,
        };
        if parsed.mint == input_mint {
            // Already in the canonical mint — nothing to bridge.
            continue;
        }
        if parsed.amount < cfg.bridge_min_balance {
            continue;
        }

        if let Err(e) = bridge_one(cfg, http, rpc, jup, config, ctx, &parsed, &input_mint).await {
            warn!(
                automation = %ctx.pubkey,
                in_mint = %parsed.mint,
                in_amount = parsed.amount,
                error = %e,
                "bridge_one failed"
            );
        }
    }
    Ok(())
}

async fn bridge_one(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    rpc: &RpcClient,
    jup: &JupiterClient,
    config: &Pubkey,
    ctx: &AutomationCtx,
    src: &ParsedTokenAccount,
    input_mint: &Pubkey,
) -> Result<()> {
    info!(
        automation = %ctx.pubkey,
        in_mint = %src.mint,
        out_mint = %input_mint,
        in_amount = src.amount,
        "bridge_attempt"
    );

    // Resolve a CPI-safe Jupiter route. `taker = automation PDA` because
    // Jupiter signs the inner ix's transfers as the input ATA owner, and
    // the on-chain handler refuses any other taker. `slippage_bps` here
    // is what Jupiter applies to its own quote internally; we ALSO
    // enforce a tighter floor via `min_amount_out` below so a stale
    // quote can't slip past on-chain.
    let build = jup
        .build_swap_cpi_safe(
            &src.mint,
            input_mint,
            src.amount,
            cfg.bridge_slippage_bps,
            &ctx.pubkey,
        )
        .await
        .map_err(|e| anyhow!("jupiter /build: {e}"))?;

    // Sanity-check that Jupiter returned the canonical v6 program; the
    // on-chain handler will reject anything else, so bail early.
    let returned_program = Pubkey::from_str(&build.swap_instruction.program_id)
        .map_err(|e| anyhow!("bad programId from jupiter: {e}"))?;
    if returned_program != *jupiter_program_id() {
        return Err(anyhow!(
            "jupiter /build returned wrong programId {returned_program}, expected {}",
            jupiter_program_id()
        ));
    }

    let quoted_out: u64 = build
        .out_amount
        .parse()
        .map_err(|e| anyhow!("parse jupiter out_amount `{}`: {e}", build.out_amount))?;
    // Apply our slippage budget on top of Jupiter's quote. saturating_*
    // keeps us safe against degenerate quotes (e.g. 0); bps math is
    // u128 to avoid overflow on big mints with lots of decimals.
    let bps = cfg.bridge_slippage_bps as u128;
    let min_out_u128 = (quoted_out as u128).saturating_mul(10_000u128.saturating_sub(bps)) / 10_000;
    let min_amount_out = min_out_u128.try_into().unwrap_or(u64::MAX);
    if min_amount_out == 0 {
        return Err(anyhow!(
            "computed min_amount_out=0 from quoted_out={quoted_out}; refusing to fire a free swap"
        ));
    }

    let inner_accounts = jupiter::into_account_metas(&build.swap_instruction.accounts)
        .map_err(|e| anyhow!("parse jupiter accounts: {e}"))?;
    if inner_accounts.len() > jupiter::MAX_CPI_ACCOUNTS as usize {
        return Err(anyhow!(
            "jupiter route returned {} accounts; CPI budget is {}",
            inner_accounts.len(),
            jupiter::MAX_CPI_ACCOUNTS
        ));
    }
    let inner_data = jupiter::decode_inner_data(&build.swap_instruction.data)?;

    // The on-chain handler expects the destination (input_mint) ATA to
    // appear in the relayed accounts list at `output_ata_index`. Locate
    // it and bail if missing rather than handing the chain a sentinel
    // index it'll reject.
    let dest_ata = associated_token_address(&ctx.pubkey, input_mint);
    let pos = inner_accounts
        .iter()
        .position(|a| a.pubkey == dest_ata)
        .ok_or_else(|| anyhow!("dest ATA {dest_ata} not in jupiter swap accounts"))?;
    if pos > u8::MAX as usize {
        return Err(anyhow!("dest ATA at index {pos} > u8::MAX; impossible under CPI"));
    }
    let output_ata_index = pos as u8;

    let bridge_ix = build_execute_bridge_ix(
        &cfg.program_id,
        &cfg.keeper_pubkey,
        config,
        &ctx.pubkey,
        &inner_accounts,
        inner_data,
        output_ata_index,
        min_amount_out,
    );

    let sig = submit_with_priority(cfg, http, rpc, bridge_ix).await?;
    info!(
        automation = %ctx.pubkey,
        sig = %sig,
        in_mint = %src.mint,
        in_amount = src.amount,
        quoted_out,
        min_amount_out,
        "bridge_completed"
    );
    Ok(())
}

/// Two-pass tx submit: (1) build a probe-signed tx, ask Helius for a
/// priority-fee estimate, (2) re-sign with the tuned price and ship it
/// through the Helius sender. Mirrors the same pattern as
/// `executor::execute_one` so dispatcher tx pricing matches normal
/// fires.
async fn submit_with_priority(
    cfg: &KeeperConfig,
    http: &reqwest::Client,
    rpc: &RpcClient,
    action_ix: Instruction,
) -> Result<String> {
    let blockhash = rpc.get_latest_blockhash().await?;
    let mut ixs = vec![
        ComputeBudgetInstruction::set_compute_unit_limit(COMPUTE_UNIT_LIMIT_BRIDGE),
        ComputeBudgetInstruction::set_compute_unit_price(PRIORITY_FEE_DEFAULT_MICROLAMPORTS),
        action_ix,
    ];
    let probe_tx = sign_tx(cfg.signer.as_ref(), &cfg.keeper_pubkey, &ixs, blockhash).await?;

    let micro_lamports = match estimate_priority_fee(http, &cfg.rpc_url, &probe_tx).await {
        Ok(m) => m.max(1_000),
        Err(e) => {
            debug!(error = %e, "bridge_dispatcher: priority fee estimate failed; using default");
            PRIORITY_FEE_DEFAULT_MICROLAMPORTS
        }
    };
    ixs[1] = ComputeBudgetInstruction::set_compute_unit_price(micro_lamports);
    let final_tx = sign_tx(cfg.signer.as_ref(), &cfg.keeper_pubkey, &ixs, blockhash).await?;

    send_via_helius(http, &cfg.sender_url, &final_tx).await
}

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

/// Minimal projection of an SPL token account we actually use. Pulled
/// out of the JsonParsed RPC response so the rest of the dispatcher
/// doesn't have to know about `solana_account_decoder`'s shape.
struct ParsedTokenAccount {
    mint: Pubkey,
    amount: u64,
}

/// Extract `(mint, amount)` from a JsonParsed `UiAccountData`. Returns
/// `None` for non-Json variants (binary encoding, malformed responses)
/// or accounts that aren't SPL Token-shaped — caller treats those as
/// "skip silently."
fn parse_token_account(data: &solana_account_decoder::UiAccountData) -> Option<ParsedTokenAccount> {
    let parsed = match data {
        solana_account_decoder::UiAccountData::Json(p) => p,
        _ => return None,
    };
    // The JsonParsed response shape is:
    //   { "type": "account", "info": { "mint": "...", "tokenAmount": { "amount": "<u64-string>", ... }, ... } }
    let info = parsed.parsed.get("info")?;
    let mint_str = info.get("mint")?.as_str()?;
    let mint = Pubkey::from_str(mint_str).ok()?;
    let amount_str = info
        .get("tokenAmount")
        .and_then(|t| t.get("amount"))
        .and_then(|a| a.as_str())?;
    let amount: u64 = amount_str.parse().ok()?;
    Some(ParsedTokenAccount { mint, amount })
}
