use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use solana_sdk::pubkey::Pubkey;
use std::collections::HashSet;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, error, info, warn};

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;
use crate::program::{
    associated_token_address_for_program, spl_token_program_id, token_2022_program_id,
};
use crate::shard::{shards, Shard};
use crate::state::TriggerSpec;
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
const WS_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);

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

    let mut keepalive = tokio::time::interval(WS_KEEPALIVE_INTERVAL);
    keepalive.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        let msg = tokio::select! {
            _ = keepalive.tick() => {
                write.send(Message::Ping(Vec::new())).await?;
                continue;
            }
            msg = read.next() => {
                let Some(msg) = msg else {
                    return Err(anyhow!("ws closed"));
                };
                msg?
            }
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            Message::Ping(payload) => {
                write.send(Message::Pong(payload)).await?;
                continue;
            }
            Message::Pong(_) => continue,
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

        if let Some(err) = v.get("error") {
            return Err(anyhow!("transactionSubscribe error: {err}"));
        }

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
        let activity = TxActivity {
            account_keys: extract_account_keys(&v),
            token_balances: extract_token_balances(&v),
        };
        if activity.account_keys.is_empty() {
            debug!(shard = shard.id, "notification with no account keys");
            continue;
        }
        let touches_dex = activity.account_keys.iter().any(|k| {
            let s = k.to_string();
            KNOWN_DEX_PROGRAM_IDS.iter().any(|d| **d == s)
        });

        let set = set_rx.borrow().clone();
        let mut emitted: HashSet<Pubkey> = HashSet::new();
        for ak in &activity.account_keys {
            let matches = set.account_matches(ak);
            if matches.is_empty() {
                continue;
            }
            let filtered: Vec<_> = matches
                .iter()
                // Drop tail-of-chain rules whose upstream hasn't fired yet.
                .filter(|m| m.armed)
                .filter(|m| emitted.insert(m.pubkey))
                .filter(|m| account_activity_matches(&activity, &m.trigger, touches_dex))
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
}

#[derive(Debug)]
struct TxActivity {
    account_keys: Vec<Pubkey>,
    token_balances: Vec<TxTokenBalance>,
}

#[derive(Debug)]
struct TxTokenBalance {
    account: Option<Pubkey>,
    owner: Option<Pubkey>,
    mint: Pubkey,
}

fn account_activity_matches(
    activity: &TxActivity,
    trigger: &TriggerSpec,
    touches_dex: bool,
) -> bool {
    let TriggerSpec::AccountActivity {
        account,
        mint,
        kind,
    } = trigger
    else {
        return true;
    };

    // Swap-mode triggers must touch a known DEX program. A plain token
    // transfer may include the same wallet/ATA but should not fire a
    // "swaps" automation.
    if *kind == 1 && !touches_dex {
        return false;
    }

    match mint {
        Some(mint) => activity_involves_mint_for_account(activity, account, mint),
        None => true,
    }
}

fn activity_involves_mint_for_account(
    activity: &TxActivity,
    account: &Pubkey,
    mint: &Pubkey,
) -> bool {
    let legacy_ata = associated_token_address_for_program(account, mint, spl_token_program_id());
    let token_2022_ata =
        associated_token_address_for_program(account, mint, token_2022_program_id());

    activity.token_balances.iter().any(|b| {
        b.mint == *mint
            && (b.owner.as_ref() == Some(account)
                || b.account.as_ref() == Some(account)
                || b.account == Some(legacy_ata)
                || b.account == Some(token_2022_ata))
    }) || activity
        .account_keys
        .iter()
        .any(|k| *k == legacy_ata || *k == token_2022_ata)
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
    for path in [
        "/params/result/transaction/meta/loadedAddresses/writable",
        "/params/result/transaction/meta/loadedAddresses/readonly",
    ] {
        if let Some(arr) = v.pointer(path).and_then(Value::as_array) {
            for k in arr {
                if let Some(pk) = k.as_str() {
                    if let Ok(p) = Pubkey::from_str(pk) {
                        out.push(p);
                    }
                }
            }
        }
    }
    out
}

fn extract_token_balances(v: &Value) -> Vec<TxTokenBalance> {
    let account_keys = extract_account_keys(v);
    let mut out = Vec::new();
    for path in [
        "/params/result/transaction/meta/preTokenBalances",
        "/params/result/transaction/meta/postTokenBalances",
    ] {
        let Some(arr) = v.pointer(path).and_then(Value::as_array) else {
            continue;
        };
        for item in arr {
            let Some(mint) = item
                .get("mint")
                .and_then(Value::as_str)
                .and_then(|s| Pubkey::from_str(s).ok())
            else {
                continue;
            };
            let account = item
                .get("accountIndex")
                .and_then(Value::as_u64)
                .and_then(|idx| account_keys.get(idx as usize).copied());
            let owner = item
                .get("owner")
                .and_then(Value::as_str)
                .and_then(|s| Pubkey::from_str(s).ok());
            out.push(TxTokenBalance {
                account,
                owner,
                mint,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_swap_specific_mint_matches_owner_token_balance() {
        let account = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let ata = associated_token_address_for_program(&account, &mint, spl_token_program_id());
        let v = json!({
            "params": {
                "result": {
                    "transaction": {
                        "transaction": {
                            "message": {
                                "accountKeys": [
                                    {"pubkey": ata.to_string()},
                                    {"pubkey": KNOWN_DEX_PROGRAM_IDS[0]}
                                ]
                            }
                        },
                        "meta": {
                            "postTokenBalances": [
                                {"accountIndex": 0, "mint": mint.to_string(), "owner": account.to_string()}
                            ]
                        }
                    }
                }
            }
        });
        let activity = TxActivity {
            account_keys: extract_account_keys(&v),
            token_balances: extract_token_balances(&v),
        };
        let trigger = TriggerSpec::AccountActivity {
            account,
            mint: Some(mint),
            kind: 1,
        };

        assert!(account_activity_matches(&activity, &trigger, true));
    }

    #[test]
    fn account_swap_specific_mint_rejects_other_mint() {
        let account = Pubkey::new_unique();
        let wanted_mint = Pubkey::new_unique();
        let other_mint = Pubkey::new_unique();
        let ata =
            associated_token_address_for_program(&account, &other_mint, spl_token_program_id());
        let v = json!({
            "params": {
                "result": {
                    "transaction": {
                        "transaction": {
                            "message": {
                                "accountKeys": [
                                    {"pubkey": ata.to_string()},
                                    {"pubkey": KNOWN_DEX_PROGRAM_IDS[0]}
                                ]
                            }
                        },
                        "meta": {
                            "postTokenBalances": [
                                {"accountIndex": 0, "mint": other_mint.to_string(), "owner": account.to_string()}
                            ]
                        }
                    }
                }
            }
        });
        let activity = TxActivity {
            account_keys: extract_account_keys(&v),
            token_balances: extract_token_balances(&v),
        };
        let trigger = TriggerSpec::AccountActivity {
            account,
            mint: Some(wanted_mint),
            kind: 1,
        };

        assert!(!account_activity_matches(&activity, &trigger, true));
    }
}
