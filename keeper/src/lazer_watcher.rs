//! Pyth Lazer (Lazer-native protocol) watcher.
//!
//! Sub-second-cadence price stream via Pyth Pro. Runs ALONGSIDE
//! `price_watcher.rs` (Hermes polling, 12s) when `LAZER_ACCESS_TOKEN`
//! is set. The executor's `Dedupe.fired` set means whichever watcher
//! emits a `TriggerEvent` first wins; the slower duplicate is dropped.
//!
//! When the access token expires:
//! - Server upgrade returns 401 on every reconnect attempt.
//! - The watcher logs the failure and backs off (capped at 60s) but
//!   keeps trying so an admin can rotate the token via Fly secrets
//!   without redeploying.
//! - Hermes price_watcher continues polling at its 12s cadence, so the
//!   protocol stays online with degraded latency until the token is
//!   replaced (or removed via `fly secrets unset LAZER_ACCESS_TOKEN`).
//!
//! Endpoint: `wss://pyth-lazer-0.dourolabs.app/v1/stream` (Lazer-native
//! protocol, numeric `priceFeedIds`).
//! Auth   : `Authorization: Bearer <LAZER_ACCESS_TOKEN>` on the upgrade.
//! Mapping: at startup we GET `https://history.pyth-lazer.dourolabs.app/v1/symbols`
//!          and build `hermes_hex → (lazer_id, exponent)`. Sotama's
//!          on-chain AssetPrice trigger stores the feed as a Pubkey
//!          containing the 32 bytes of the Hermes hex feed id, so this
//!          map is exactly what we need to translate to Lazer-native
//!          numeric ids for the SubscribeRequest.
//!
//! Scope:
//! - Plain `AssetPrice` triggers (`quote_mint = None`) go through Lazer.
//! - `PriceRatio` triggers (`quote_mint = Some(mint)`) need a Jupiter
//!   `/quote` round-trip per evaluation, which would erase the latency
//!   win. Hermes price_watcher handles those at its 12s tick.

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use pyth_lazer_protocol::api::{
    Channel, DeliveryFormat, Format, JsonBinaryEncoding, ParsedFeedPayload, SubscribeRequest,
    SubscriptionId, SubscriptionParams, SubscriptionParamsRepr, WsRequest, WsResponse,
};
use pyth_lazer_protocol::time::FixedRate;
use pyth_lazer_protocol::{PriceFeedId, PriceFeedProperty};
use serde::Deserialize;
use solana_sdk::pubkey::Pubkey;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};

use crate::config::KeeperConfig;
use crate::indexer::WatchedSet;
use crate::price_watcher::{crossed_above, crossed_below, LatestPrice};
use crate::prices::cache::{PriceCache, PriceSnapshot, SourceLayer};
use crate::state::TriggerSpec;
use crate::types::{AutomationCtx, TriggerEvent};

const LAZER_ENDPOINTS: &[&str] = &[
    "wss://pyth-lazer-0.dourolabs.app/v1/stream",
    "wss://pyth-lazer-1.dourolabs.app/v1/stream",
    "wss://pyth-lazer-2.dourolabs.app/v1/stream",
];

const SYMBOLS_URL: &str = "https://history.pyth-lazer.dourolabs.app/v1/symbols";

/// Cap a single reconnection backoff. Reasonable upper bound for an
/// expired or revoked token: chatty enough that an admin notices but
/// doesn't pin a CPU when auth's clearly not coming back.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// Per-feed metadata we cache from `/v1/symbols` at startup. Keyed by
/// the 32-byte Hermes feed id (same bytes the on-chain AssetPrice
/// trigger stores in its `feed: Pubkey`).
#[derive(Debug, Clone)]
struct FeedMeta {
    lazer_id: u32,
    exponent: i32,
}

// `active_feeds_tx`: set of feed pubkeys Lazer is currently streaming.
// Hermes (price_watcher) reads this and skips polling those feeds so
// the two paths don't both fire on the same crossing — Lazer is the
// primary source whenever it's connected; Hermes only handles gaps.
// Cleared on disconnect so Hermes resumes covering them.
pub async fn run(
    cfg: Arc<KeeperConfig>,
    set_rx: watch::Receiver<WatchedSet>,
    trigger_tx: mpsc::Sender<TriggerEvent>,
    active_feeds_tx: watch::Sender<HashSet<Pubkey>>,
    price_cache: PriceCache,
) -> Result<()> {
    let token = match cfg.lazer_access_token.as_ref() {
        Some(t) => t.clone(),
        None => {
            info!("lazer_watcher: LAZER_ACCESS_TOKEN not set; Hermes polling will cover all price triggers");
            // Make sure the active set stays empty so Hermes covers
            // everything. (It already is via the channel default.)
            let _ = active_feeds_tx.send(HashSet::new());
            return Ok(());
        }
    };

    info!("lazer_watcher: starting Pyth Lazer Lazer-native stream");

    // Fetch the symbol catalog once. ~3.2k symbols, ~500 KB. We cache
    // hermes_hex → (lazer_id, exponent) and a reverse map so price
    // updates can be translated back to a Sotama Pubkey.
    let (hermes_to_meta, lazer_to_hermes) = match fetch_symbol_maps().await {
        Ok(maps) => maps,
        Err(e) => {
            warn!(error = %e, "lazer_watcher: failed to fetch symbol catalog; Hermes polling will cover triggers");
            return Ok(());
        }
    };
    info!(
        feeds = hermes_to_meta.len(),
        "lazer_watcher: loaded Lazer symbol catalog"
    );

    let hermes_to_meta = Arc::new(hermes_to_meta);
    let lazer_to_hermes = Arc::new(lazer_to_hermes);

    let mut endpoint_idx = 0usize;
    let mut backoff = Duration::from_secs(1);

    loop {
        let endpoint = LAZER_ENDPOINTS[endpoint_idx % LAZER_ENDPOINTS.len()];
        endpoint_idx = endpoint_idx.wrapping_add(1);

        let result = connect_and_run(
            endpoint,
            &token,
            &set_rx,
            &trigger_tx,
            &hermes_to_meta,
            &lazer_to_hermes,
            &active_feeds_tx,
            &price_cache,
        )
        .await;

        // Whether the connection ended cleanly or with an error, we're
        // no longer streaming — clear the active set so price_watcher
        // knows to take over those feeds until we reconnect.
        let _ = active_feeds_tx.send(HashSet::new());

        match result {
            Ok(()) => {
                debug!(endpoint, "lazer_watcher: stream closed cleanly; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                warn!(
                    endpoint,
                    error = format!("{e:#}"),
                    backoff_secs = backoff.as_secs(),
                    "lazer_watcher: connection failed; backing off — Hermes covers the feeds"
                );
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn fetch_symbol_maps() -> Result<(HashMap<[u8; 32], FeedMeta>, HashMap<u32, [u8; 32]>)> {
    #[derive(Deserialize)]
    struct SymbolRow {
        pyth_lazer_id: u32,
        exponent: i32,
        #[serde(default)]
        hermes_id: Option<String>,
    }

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let rows: Vec<SymbolRow> = http
        .get(SYMBOLS_URL)
        .send()
        .await
        .context("symbols GET")?
        .error_for_status()?
        .json()
        .await
        .context("symbols decode")?;

    let mut hermes_to_meta = HashMap::with_capacity(rows.len());
    let mut lazer_to_hermes = HashMap::with_capacity(rows.len());
    for r in rows {
        let Some(hex_str) = r.hermes_id else { continue };
        let s = hex_str.strip_prefix("0x").unwrap_or(&hex_str);
        let bytes = match hex::decode(s) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let arr: [u8; 32] = match bytes.try_into() {
            Ok(a) => a,
            Err(_) => continue,
        };
        hermes_to_meta.insert(
            arr,
            FeedMeta {
                lazer_id: r.pyth_lazer_id,
                exponent: r.exponent,
            },
        );
        lazer_to_hermes.insert(r.pyth_lazer_id, arr);
    }
    Ok((hermes_to_meta, lazer_to_hermes))
}

async fn connect_and_run(
    endpoint: &str,
    token: &str,
    set_rx: &watch::Receiver<WatchedSet>,
    trigger_tx: &mpsc::Sender<TriggerEvent>,
    hermes_to_meta: &Arc<HashMap<[u8; 32], FeedMeta>>,
    lazer_to_hermes: &Arc<HashMap<u32, [u8; 32]>>,
    active_feeds_tx: &watch::Sender<HashSet<Pubkey>>,
    price_cache: &PriceCache,
) -> Result<()> {
    let mut req = endpoint.into_client_request().context("parse lazer endpoint")?;
    let auth_value: http::HeaderValue = format!("Bearer {token}")
        .parse()
        .context("build authorization header")?;
    req.headers_mut().insert(http::header::AUTHORIZATION, auth_value);

    let (ws, _resp) = connect_async(req).await.context("ws connect")?;
    debug!(endpoint, "lazer_watcher: connected");
    let mut ws = ws;

    // Translate the seeded watched set's Hermes-hex feeds to Lazer
    // numeric ids using our symbol map. Feeds that aren't in the map
    // (e.g. a switchboard-pending pubkey) are silently dropped — the
    // Hermes watcher's Pyth Hermes path handles those via its USD-only
    // polling logic.
    let mut subscribed_lazer: Vec<u32> = current_lazer_ids(set_rx, hermes_to_meta);
    if !subscribed_lazer.is_empty() {
        send_subscribe(&mut ws, &subscribed_lazer).await?;
        info!(
            endpoint,
            feeds = subscribed_lazer.len(),
            "lazer_watcher: subscribed"
        );
    } else {
        debug!(endpoint, "lazer_watcher: no AssetPrice triggers yet; idle");
    }
    publish_active_feeds(active_feeds_tx, &subscribed_lazer, lazer_to_hermes);

    let mut set_rx_local = set_rx.clone();
    // Track consecutive failed text-frame parses. A persistent stream of
    // unparseable messages used to silently drop every feed tick while the
    // connection stayed open. After this many consecutive failures, return
    // an error so the outer loop reconnects fresh (H4).
    const PARSE_ERROR_LIMIT: u32 = 5;
    let mut consecutive_parse_errors: u32 = 0;
    loop {
        tokio::select! {
            res = set_rx_local.changed() => {
                if res.is_err() { break; }
                let new_ids = current_lazer_ids(&set_rx_local, hermes_to_meta);
                let added: Vec<u32> = new_ids.iter().filter(|id| !subscribed_lazer.contains(id)).copied().collect();
                let removed: Vec<u32> = subscribed_lazer.iter().filter(|id| !new_ids.contains(id)).copied().collect();
                if !added.is_empty() {
                    send_subscribe(&mut ws, &added).await?;
                    info!(added = added.len(), "lazer_watcher: subscribed to added feeds");
                }
                if !removed.is_empty() {
                    send_unsubscribe(&mut ws, &removed).await?;
                    debug!(removed = removed.len(), "lazer_watcher: unsubscribed from removed feeds");
                }
                subscribed_lazer = new_ids;
                publish_active_feeds(active_feeds_tx, &subscribed_lazer, lazer_to_hermes);
            }

            msg = ws.next() => {
                let msg = match msg {
                    Some(Ok(m)) => m,
                    Some(Err(e)) => return Err(anyhow!("ws read: {e}")),
                    None => break,
                };
                match msg {
                    Message::Text(text) => {
                        match handle_text(&text, set_rx, trigger_tx, hermes_to_meta, lazer_to_hermes, price_cache).await {
                            Ok(()) => consecutive_parse_errors = 0,
                            Err(e) => {
                                consecutive_parse_errors = consecutive_parse_errors.saturating_add(1);
                                warn!(
                                    error = %e,
                                    snippet = %text.chars().take(120).collect::<String>(),
                                    consecutive = consecutive_parse_errors,
                                    "lazer_watcher: failed to parse server message",
                                );
                                if consecutive_parse_errors >= PARSE_ERROR_LIMIT {
                                    return Err(anyhow!(
                                        "lazer_watcher: {consecutive_parse_errors} consecutive parse errors; reconnecting",
                                    ));
                                }
                            }
                        }
                    }
                    Message::Ping(p) => {
                        ws.send(Message::Pong(p)).await.context("ws pong")?;
                    }
                    Message::Close(_) => {
                        debug!("lazer_watcher: server closed stream");
                        break;
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

/// Translate the currently-subscribed Lazer feed ids back to Hermes
/// pubkeys and publish them on the shared "Lazer is covering these"
/// channel. price_watcher reads this and skips polling those feeds —
/// the two paths must not both fire on the same crossing.
fn publish_active_feeds(
    tx: &watch::Sender<HashSet<Pubkey>>,
    lazer_ids: &[u32],
    lazer_to_hermes: &HashMap<u32, [u8; 32]>,
) {
    let mut set = HashSet::with_capacity(lazer_ids.len());
    for id in lazer_ids {
        if let Some(bytes) = lazer_to_hermes.get(id) {
            set.insert(Pubkey::new_from_array(*bytes));
        }
    }
    let _ = tx.send(set);
}

fn current_lazer_ids(
    set_rx: &watch::Receiver<WatchedSet>,
    hermes_to_meta: &HashMap<[u8; 32], FeedMeta>,
) -> Vec<u32> {
    // Lazer is a Pyth wire format — only PYTH-sourced triggers are
    // candidates. Jupiter-sourced triggers are watched by jupiter_watcher.
    let feeds = set_rx
        .borrow()
        .price_feeds_for_source(crate::state::oracle_source::PYTH);
    let mut out = Vec::with_capacity(feeds.len());
    for f in feeds {
        if let Some(meta) = hermes_to_meta.get(&f.to_bytes()) {
            out.push(meta.lazer_id);
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

async fn send_subscribe(
    ws: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    feeds: &[u32],
) -> Result<()> {
    // SubscriptionId is per-WS-connection state on the server; we use 1
    // for everything since we only ever have one subscription per
    // connection (we delta-subscribe by adding ids to the same
    // subscription rather than creating a new one).
    // Lazer's WS protocol uses a tagged-enum request envelope
    // (`WsRequest` with `#[serde(tag = "type")]`); sending a bare
    // SubscribeRequest produces a JSON with no `type` field and the
    // server rejects it as "invalid request: missing field `type`".
    let req = WsRequest::Subscribe(SubscribeRequest {
        subscription_id: SubscriptionId(1),
        params: SubscriptionParams::new(SubscriptionParamsRepr {
            price_feed_ids: Some(feeds.iter().copied().map(PriceFeedId).collect()),
            symbols: None,
            properties: vec![PriceFeedProperty::Price, PriceFeedProperty::Exponent],
            // Lazer requires at least one signed format. Solana is the
            // smallest payload that satisfies the gate; we ignore the
            // signed bytes since we trust the keeper-as-signer model on
            // chain (the executor handles the actual ix signing).
            formats: vec![Format::Solana],
            delivery_format: DeliveryFormat::Json,
            json_binary_encoding: JsonBinaryEncoding::Base64,
            parsed: true,
            channel: Channel::FixedRate(FixedRate::RATE_200_MS),
            ignore_invalid_feeds: true,
        })
        .map_err(|e| anyhow!("invalid subscribe params: {e}"))?,
    });
    let json = serde_json::to_string(&req).context("serialize subscribe")?;
    ws.send(Message::Text(json.into())).await.context("ws send subscribe")?;
    Ok(())
}

async fn send_unsubscribe(
    ws: &mut WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
    _feeds: &[u32],
) -> Result<()> {
    // Lazer's UnsubscribeRequest works on a SubscriptionId, not on a
    // feed list. Since we use a single subscription per connection,
    // unsubscribing means killing the WHOLE stream, which would also
    // kill subscriptions to feeds we still care about. The simpler
    // pattern: drop the connection and let the reconnect loop
    // re-subscribe with the current set. We log here but don't act —
    // the indexer's next reconcile (60s) will trigger a re-subscribe
    // via the watch channel anyway.
    debug!("lazer_watcher: feed removed (no-op; reconnect will re-subscribe with new set)");
    Ok(())
}

/// Returns `Err` when parsing the server message fails. The caller
/// tracks consecutive parse failures and forces a reconnect after a
/// threshold so a stuck/corrupted stream can't silently mute every
/// AssetPrice trigger (H4).
async fn handle_text(
    text: &str,
    set_rx: &watch::Receiver<WatchedSet>,
    trigger_tx: &mpsc::Sender<TriggerEvent>,
    hermes_to_meta: &Arc<HashMap<[u8; 32], FeedMeta>>,
    lazer_to_hermes: &Arc<HashMap<u32, [u8; 32]>>,
    price_cache: &PriceCache,
) -> std::result::Result<(), serde_json::Error> {
    let parsed: WsResponse = serde_json::from_str(text)?;
    match parsed {
        WsResponse::Subscribed(s) => {
            debug!(subscription_id = s.subscription_id.0, "lazer_watcher: subscription ack");
        }
        WsResponse::SubscribedWithInvalidFeedIdsIgnored(s) => {
            warn!(
                subscription_id = s.subscription_id.0,
                accepted = s.subscribed_feed_ids.len(),
                "lazer_watcher: some feed ids were invalid (server ignored them)"
            );
        }
        WsResponse::Unsubscribed(_) => debug!("lazer_watcher: unsubscribe ack"),
        WsResponse::SubscriptionError(e) => {
            warn!(error = %e.error, "lazer_watcher: subscription error");
        }
        WsResponse::Error(e) => {
            warn!(error = %e.error, "lazer_watcher: server error");
        }
        WsResponse::StreamUpdated(update) => {
            if let Some(parsed) = update.payload.parsed {
                for feed in parsed.price_feeds {
                    process_feed_update(set_rx, trigger_tx, hermes_to_meta, lazer_to_hermes, price_cache, &feed)
                        .await;
                }
            }
        }
    }
    Ok(())
}

async fn process_feed_update(
    set_rx: &watch::Receiver<WatchedSet>,
    trigger_tx: &mpsc::Sender<TriggerEvent>,
    hermes_to_meta: &Arc<HashMap<[u8; 32], FeedMeta>>,
    lazer_to_hermes: &Arc<HashMap<u32, [u8; 32]>>,
    price_cache: &PriceCache,
    feed: &ParsedFeedPayload,
) {
    let lazer_id = feed.price_feed_id.0;
    let Some(hermes_bytes) = lazer_to_hermes.get(&lazer_id) else {
        return;
    };
    let feed_pk = Pubkey::new_from_array(*hermes_bytes);

    // Only PYTH-sourced triggers route through Lazer; JUPITER triggers
    // are handled by jupiter_watcher.
    let matches = set_rx
        .borrow()
        .price_matches_for_source(&feed_pk, crate::state::oracle_source::PYTH);
    if matches.is_empty() {
        return;
    }

    let Some(price) = feed.price else { return };
    let raw: i64 = price.mantissa_i64();

    // Trust the cached exponent loaded from /v1/symbols at startup —
    // that is the canonical scale Lazer publishes for this feed. The
    // per-update `feed.exponent` is informational; if it disagrees with
    // the cached value, drop the tick rather than fire on a misscaled
    // comparison (C1). This used to default to 0 on missing exponent,
    // which silently inflated non-USDC-scale comparisons by 10^N.
    let cached_expo: i32 = match hermes_to_meta.get(hermes_bytes) {
        Some(m) => m.exponent,
        None => {
            warn!(
                lazer_id,
                feed = %feed_pk,
                "lazer_watcher: feed update for symbol not in cached catalog; dropping",
            );
            return;
        }
    };
    if let Some(server_expo) = feed.exponent {
        if i32::from(server_expo) != cached_expo {
            warn!(
                lazer_id,
                feed = %feed_pk,
                cached_expo,
                server_expo = i32::from(server_expo),
                "lazer_watcher: per-update exponent disagrees with cached catalog; skipping tick",
            );
            return;
        }
    }
    let expo = cached_expo;
    let publish_time: i64 = parsed_timestamp_to_unix_seconds(&feed);

    // Write the price snapshot into the shared PriceCache so downstream
    // consumers (e.g. the stream orchestrator) can read it without an
    // additional Hermes round-trip. The feed_id key is the hex-encoded
    // Hermes bytes, matching the format used by hermes_sse and active_feed_ids.
    // raw_price + expo are populated so the cache-driven evaluator in
    // price_watcher can perform Pyth-quoted ratio comparisons without
    // falling back to the slower 12s poll path.
    let scale = 10f64.powi(expo);
    let snap = PriceSnapshot {
        price: raw as f64 * scale,
        conf: 0.0, // Lazer parsed feed doesn't carry a separate conf field
        publish_time,
        fetched_at: std::time::Instant::now(),
        source: SourceLayer::Lazer,
        raw_price: Some(raw),
        expo: Some(expo),
    };
    price_cache.put(hex::encode(hermes_bytes), snap.clone()).await;

    let latest = LatestPrice {
        raw,
        expo,
        publish_time,
    };

    let mut to_fire: Vec<AutomationCtx> = Vec::new();
    for ctx in matches {
        if let TriggerSpec::AssetPrice {
            quote_mint: None,
            comparator,
            threshold,
            expo: trigger_expo,
            ..
        } = &ctx.trigger
        {
            let crossed = match *comparator {
                0 => crossed_below(&latest, *threshold, *trigger_expo),
                1 => crossed_above(&latest, *threshold, *trigger_expo),
                _ => false,
            };
            if crossed {
                to_fire.push(ctx);
            }
        }
    }

    if to_fire.is_empty() {
        return;
    }

    let correlation = format!("lazer:{lazer_id}:{publish_time}");
    info!(
        count = to_fire.len(),
        correlation, "lazer_watcher: threshold crossed; firing"
    );
    let evt = TriggerEvent {
        source: "lazer_watcher",
        correlation,
        matches: to_fire,
        depth: 0,
        snapshot: Some(snap),
    };
    if let Err(e) = trigger_tx.send(evt).await {
        warn!(error = %e, "lazer_watcher: trigger channel closed");
    }
}

/// `ParsedFeedPayload` doesn't carry per-feed publish_time; the
/// timestamp lives on the parent `ParsedPayload.timestamp_us`. We pass
/// only the per-feed item to this helper, so we approximate by treating
/// the dispatch time as "now". Used solely for the dedupe correlation
/// id, not for any threshold math.
fn parsed_timestamp_to_unix_seconds(_feed: &ParsedFeedPayload) -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
