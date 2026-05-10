use super::decoder::decode_logs;
use crate::events::AutomationLifecycle;
use crate::streaming::{LogEvent, StreamSource};
use solana_sdk::pubkey::Pubkey;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, info};

/// Spawn a background task that:
/// 1. Opens a `logsSubscribe` stream for `program` via `source`.
/// 2. Decodes each transaction's logs into `AutomationLifecycle` events.
/// 3. Forwards decoded events on `out`.
/// 4. Sends a unit on `reconcile_tx` whenever the underlying WebSocket
///    reconnects — the handler in Task 10 will trigger a full reconcile to
///    cover any events missed during the gap.
pub fn spawn(
    source: Arc<dyn StreamSource>,
    program: Pubkey,
    out: mpsc::Sender<AutomationLifecycle>,
    reconcile_tx: mpsc::Sender<()>,
) {
    tokio::spawn(async move {
        let mut rx = match source.subscribe_logs(program).await {
            Ok(rx) => rx,
            Err(e) => {
                tracing::error!(
                    target: "events::subscriber",
                    error = %e,
                    "subscribe_logs failed at startup"
                );
                return;
            }
        };
        info!(
            target: "events::subscriber",
            program = %program,
            "subscribed to logsSubscribe"
        );
        while let Some(LogEvent { signature, slot, logs, err }) = rx.recv().await {
            // Reconnect sentinel injected by WsStreamSource on each fresh WS connection.
            if signature == "__RECONNECTED__" {
                info!(target: "events::subscriber", "reconnected — requesting reconcile");
                let _ = reconcile_tx.send(()).await;
                continue;
            }
            // Skip failed transactions — no state transition occurred.
            if err.is_some() {
                continue;
            }
            for ev in decode_logs(&logs) {
                debug!(
                    target: "events::subscriber",
                    %signature,
                    slot,
                    kind = ?ev,
                    "lifecycle event decoded"
                );
                if out.send(ev).await.is_err() {
                    // Receiver dropped — lifecycle consumer task is gone; exit cleanly.
                    return;
                }
            }
        }
    });
}
