use super::{AccountUpdate, LogEvent, StreamSource};
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use solana_sdk::pubkey::Pubkey;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::warn;

pub struct WsStreamSource {
    pub url: String,
}

impl WsStreamSource {
    pub fn new(url: String) -> Self {
        Self { url }
    }
}

#[async_trait]
impl StreamSource for WsStreamSource {
    async fn subscribe_logs(&self, program: Pubkey) -> Result<mpsc::Receiver<LogEvent>> {
        let (tx, rx) = mpsc::channel(1024);
        let url = self.url.clone();
        let program_str = program.to_string();
        tokio::spawn(async move {
            let mut backoff = Duration::from_secs(1);
            loop {
                match run_logs_subscription(&url, &program_str, &tx).await {
                    Ok(()) => return, // tx dropped → caller hung up
                    Err(e) => {
                        warn!(target: "streaming::ws", error = %e, "logs subscription dropped");
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                    }
                }
            }
        });
        Ok(rx)
    }

    async fn subscribe_account(&self, account: Pubkey) -> Result<mpsc::Receiver<AccountUpdate>> {
        let (tx, rx) = mpsc::channel(1024);
        let url = self.url.clone();
        let acct_str = account.to_string();
        tokio::spawn(async move {
            let mut backoff = Duration::from_secs(1);
            loop {
                match run_account_subscription(&url, &acct_str, account, &tx).await {
                    Ok(()) => return,
                    Err(e) => {
                        warn!(target: "streaming::ws", error = %e, "account subscription dropped");
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(30));
                    }
                }
            }
        });
        Ok(rx)
    }
}

async fn run_logs_subscription(
    url: &str,
    program: &str,
    tx: &mpsc::Sender<LogEvent>,
) -> Result<()> {
    let (mut ws, _) = connect_async(url).await?;
    // Sentinel: tells consumers "fresh subscription, run reconcile" (Task 10 consumer side).
    let _ = tx
        .send(LogEvent {
            signature: "__RECONNECTED__".into(),
            slot: 0,
            logs: vec![],
            err: None,
        })
        .await;
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "logsSubscribe",
        "params": [
            { "mentions": [program] },
            { "commitment": "confirmed" }
        ]
    });
    ws.send(Message::Text(req.to_string().into())).await?;
    while let Some(msg) = ws.next().await {
        let msg = msg?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
            Message::Close(_) => return Err(anyhow!("ws closed")),
            _ => continue,
        };
        let val: Value = serde_json::from_str(&text)?;
        if val.get("method").and_then(|m| m.as_str()) != Some("logsNotification") {
            continue;
        }
        let result = val
            .pointer("/params/result/value")
            .ok_or_else(|| anyhow!("no value"))?;
        let signature = result
            .get("signature")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        let logs: Vec<String> = result
            .get("logs")
            .and_then(|l| l.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        let err = result.get("err").and_then(|e| {
            if e.is_null() {
                None
            } else {
                Some(e.to_string())
            }
        });
        let slot = val
            .pointer("/params/result/context/slot")
            .and_then(|s| s.as_u64())
            .unwrap_or(0);
        let event = LogEvent {
            signature,
            slot,
            logs,
            err,
        };
        if tx.send(event).await.is_err() {
            return Ok(());
        }
    }
    Err(anyhow!("ws closed"))
}

async fn run_account_subscription(
    url: &str,
    account_str: &str,
    account: Pubkey,
    tx: &mpsc::Sender<AccountUpdate>,
) -> Result<()> {
    let (mut ws, _) = connect_async(url).await?;
    let req = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "accountSubscribe",
        "params": [
            account_str,
            { "commitment": "confirmed", "encoding": "base64" }
        ]
    });
    ws.send(Message::Text(req.to_string().into())).await?;
    while let Some(msg) = ws.next().await {
        let msg = msg?;
        let text = match msg {
            Message::Text(t) => t,
            Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
            Message::Close(_) => return Err(anyhow!("ws closed")),
            _ => continue,
        };
        let val: Value = serde_json::from_str(&text)?;
        if val.get("method").and_then(|m| m.as_str()) != Some("accountNotification") {
            continue;
        }
        let value = val
            .pointer("/params/result/value")
            .ok_or_else(|| anyhow!("no value"))?;
        let lamports = value.get("lamports").and_then(|v| v.as_u64()).unwrap_or(0);
        let slot = val
            .pointer("/params/result/context/slot")
            .and_then(|s| s.as_u64())
            .unwrap_or(0);
        let data_b64 = value
            .pointer("/data/0")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let data = base64::engine::general_purpose::STANDARD
            .decode(data_b64)
            .unwrap_or_default();
        let update = AccountUpdate {
            account,
            slot,
            lamports,
            data,
        };
        if tx.send(update).await.is_err() {
            return Ok(());
        }
    }
    Err(anyhow!("ws closed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_logs_notification_shape() {
        let raw = r#"{
            "jsonrpc":"2.0",
            "method":"logsNotification",
            "params":{"result":{
                "context":{"slot":123},
                "value":{"signature":"abc","logs":["Program data: AAAA"],"err":null}
            },"subscription":1}
        }"#;
        let v: Value = serde_json::from_str(raw).unwrap();
        let logs: Vec<String> = v
            .pointer("/params/result/value/logs")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|x| x.as_str().map(String::from))
            .collect();
        assert_eq!(logs, vec!["Program data: AAAA".to_string()]);
    }
}
