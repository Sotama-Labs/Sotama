use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;
use crate::shard::{shards, Shard};
use crate::types::TriggerEvent;

const KNOWN_DEX_PROGRAM_IDS: &[&str] = &[
    // Jupiter v6 — most devnet/mainnet swaps go through this
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    // Orca whirlpools
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    // Raydium AMM v4
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    // Raydium CLMM
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    // Meteora dynamic-amm
    "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB",
];

pub async fn run(
    cfg: Arc<KeeperConfig>,
    mut set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
) -> Result<()> {
    let mut current: Vec<JoinHandle<()>> = Vec::new();

    loop {
        let set = set_rx.borrow_and_update().clone();
        for h in current.drain(..) {
            h.abort();
        }
        let shard_list = shards(&set, cfg.shard_size);
        info!(
            shards = shard_list.len(),
            account_targets = set.account_triggers.len(),
            "subscriber: respawning shards"
        );
        if shard_list.is_empty() {
            debug!("subscriber: no account triggers; sleeping until set changes");
        }
        for shard in shard_list {
            let cfg = cfg.clone();
            let set_rx = set_rx.clone();
            let trigger_tx = trigger_tx.clone();
            current.push(tokio::spawn(async move {
                run_shard(cfg, shard, set_rx, trigger_tx).await;
            }));
        }

        if set_rx.changed().await.is_err() {
            warn!("subscriber: set channel closed; exiting");
            break;
        }
    }

    Ok(())
}

async fn run_shard(
    cfg: Arc<KeeperConfig>,
    shard: Shard,
    set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        match shard_loop(&cfg, &shard, &set_rx, &trigger_tx).await {
            Ok(()) => {
                info!(shard = shard.id, "shard exited cleanly; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                warn!(shard = shard.id, error = %e, backoff_ms = backoff.as_millis(), "shard error; backing off");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }
    }
}

async fn shard_loop(
    cfg: &KeeperConfig,
    shard: &Shard,
    set_rx: &watch::Receiver<WatchedSet>,
    trigger_tx: &mpsc::Sender<TriggerEvent>,
) -> Result<()> {
    let (ws, _resp) = connect_async(&cfg.ws_url).await?;
    let (mut write, mut read) = ws.split();

    let account_strs: Vec<String> = shard.accounts.iter().map(|p| p.to_string()).collect();

    let sub_msg = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "transactionSubscribe",
        "params": [
            {
                "vote": false,
                "failed": false,
                "accountInclude": account_strs,
            },
            {
                "commitment": "confirmed",
                "encoding": "jsonParsed",
                "transactionDetails": "full",
                "showRewards": false,
                "maxSupportedTransactionVersion": 0,
            }
        ]
    });
    write.send(Message::Text(sub_msg.to_string())).await?;
    info!(
        shard = shard.id,
        accounts = shard.accounts.len(),
        "shard: transactionSubscribe sent"
    );

    while let Some(msg) = read.next().await {
        let msg = msg?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => return Err(anyhow!("ws closed")),
            _ => continue,
        };

        let v: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(e) => {
                warn!(error = %e, "shard: failed to parse ws frame");
                continue;
            }
        };

        if v.get("result").is_some() && v.get("method").is_none() {
            debug!(shard = shard.id, "shard: subscribed");
            continue;
        }

        if v.get("method").and_then(Value::as_str) != Some("transactionNotification") {
            continue;
        }

        let signature = v["params"]["result"]["signature"]
            .as_str()
            .unwrap_or("")
            .to_string();
        let account_keys = extract_account_keys(&v);
        if account_keys.is_empty() {
            debug!(shard = shard.id, "notification with no account keys");
            continue;
        }
        let touches_dex = account_keys.iter().any(|k| {
            let s = k.to_string();
            KNOWN_DEX_PROGRAM_IDS.iter().any(|d| **d == s)
        });

        let set = set_rx.borrow().clone();
        for ak in &account_keys {
            let matches = set.account_matches(ak);
            if matches.is_empty() {
                continue;
            }
            // Filter swap-mode triggers to txs that touch a known DEX —
            // a transfer-only tx shouldn't fire a "swaps" trigger.
            let filtered: Vec<_> = matches
                .iter()
                // Drop tail-of-chain rules whose upstream hasn't fired yet.
                .filter(|m| m.armed)
                .filter(|m| {
                    if let crate::state::TriggerSpec::AccountActivity { kind, .. } = &m.trigger {
                        if *kind == 1 {
                            return touches_dex;
                        }
                    }
                    true
                })
                .cloned()
                .collect();
            if filtered.is_empty() {
                continue;
            }
            let evt = TriggerEvent {
                source: "account_subscriber",
                correlation: signature.clone(),
                matches: filtered,
                depth: 0,
                snapshot: None,
            };
            if let Err(e) = trigger_tx.send(evt).await {
                error!(error = %e, "shard: trigger channel closed");
                return Err(anyhow!("trigger channel closed"));
            }
        }
    }

    Ok(())
}

fn extract_account_keys(v: &Value) -> Vec<Pubkey> {
    let mut out = Vec::new();
    let keys = &v["params"]["result"]["transaction"]["transaction"]["message"]["accountKeys"];
    if let Some(arr) = keys.as_array() {
        for k in arr {
            if let Some(pk) = k.get("pubkey").and_then(Value::as_str) {
                if let Ok(p) = Pubkey::from_str(pk) {
                    out.push(p);
                }
            } else if let Some(pk) = k.as_str() {
                if let Ok(p) = Pubkey::from_str(pk) {
                    out.push(p);
                }
            }
        }
    }
    out
}
