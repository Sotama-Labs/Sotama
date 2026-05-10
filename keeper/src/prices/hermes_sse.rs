use super::cache::{PriceCache, PriceSnapshot, SourceLayer};
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use reqwest::Client;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

/// Hermes proactively closes connections at 24h. We reconnect at 23h.
const RECONNECT_INTERVAL: Duration = Duration::from_secs(23 * 60 * 60);

pub fn spawn(http: Client, base_url: String, feed_ids: Vec<String>, cache: PriceCache) {
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            let started = Instant::now();
            match run(&http, &base_url, &feed_ids, &cache, RECONNECT_INTERVAL).await {
                Ok(()) => {
                    debug!(target: "prices::hermes_sse", "reconnect window reached, reconnecting");
                    backoff = Duration::from_secs(1);
                }
                Err(e) => {
                    warn!(target: "prices::hermes_sse", error = %e, elapsed = ?started.elapsed(), "stream failed");
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }
    });
}

pub async fn run(
    http: &Client,
    base_url: &str,
    feed_ids: &[String],
    cache: &PriceCache,
    max_duration: Duration,
) -> Result<()> {
    let mut url = format!("{}/v2/updates/price/stream?", base_url.trim_end_matches('/'));
    for (i, id) in feed_ids.iter().enumerate() {
        if i > 0 { url.push('&') }
        url.push_str("ids[]=");
        url.push_str(id);
    }
    url.push_str("&parsed=true&encoding=base64");

    let resp = http.get(&url).send().await?;
    if !resp.status().is_success() {
        return Err(anyhow!("hermes sse status {}", resp.status()));
    }

    let mut stream = resp.bytes_stream();
    let started = Instant::now();
    let mut buf: Vec<u8> = Vec::new();

    while let Some(chunk) = stream.next().await {
        if started.elapsed() >= max_duration { return Ok(()) }
        let chunk = chunk?;
        buf.extend_from_slice(chunk.as_ref());
        while let Some(pos) = find_double_newline(&buf) {
            let frame = buf.drain(..pos + 2).collect::<Vec<u8>>();
            let frame_str = String::from_utf8_lossy(&frame);
            for line in frame_str.lines() {
                if let Some(payload) = line.strip_prefix("data: ") {
                    handle_payload(payload.trim(), cache).await;
                }
            }
        }
    }
    Err(anyhow!("hermes sse closed unexpectedly"))
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    for i in 0..buf.len().saturating_sub(1) {
        if buf[i] == b'\n' && buf[i + 1] == b'\n' { return Some(i) }
    }
    None
}

async fn handle_payload(payload: &str, cache: &PriceCache) {
    if payload == "[DONE]" || payload.is_empty() { return }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else { return };
    let Some(parsed) = v.get("parsed").and_then(|p| p.as_array()) else { return };
    for item in parsed {
        let Some(id) = item.get("id").and_then(|x| x.as_str()) else { continue };
        let Some(price_obj) = item.get("price") else { continue };
        let Some(price_raw) = price_obj.get("price").and_then(|x| x.as_str()).and_then(|s| s.parse::<i64>().ok()) else { continue };
        let Some(expo) = price_obj.get("expo").and_then(|x| x.as_i64()) else { continue };
        let conf_raw: i64 = price_obj.get("conf").and_then(|x| x.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0);
        let publish_time = price_obj.get("publish_time").and_then(|x| x.as_i64()).unwrap_or(0);
        let scale = 10f64.powi(expo as i32);
        let snap = PriceSnapshot {
            price: price_raw as f64 * scale,
            conf: conf_raw as f64 * scale,
            publish_time,
            fetched_at: Instant::now(),
            source: SourceLayer::HermesSse,
        };
        cache.put(id.to_string(), snap).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_double_newline_at_end_of_frame() {
        let buf = b"data: hello\n\n";
        assert_eq!(find_double_newline(buf), Some(11));
    }

    #[test]
    fn no_double_newline_returns_none() {
        let buf = b"data: hello\n";
        assert_eq!(find_double_newline(buf), None);
    }

    #[tokio::test]
    async fn handle_payload_inserts_into_cache() {
        let cache = PriceCache::new();
        let payload = r#"{"parsed":[{
            "id":"abc",
            "price":{"price":"12345","expo":-2,"conf":"10","publish_time":1700000000}
        }]}"#;
        handle_payload(payload, &cache).await;
        let snap = cache.get_fresh("abc").await.unwrap();
        assert!((snap.price - 123.45).abs() < 1e-9);
        assert_eq!(snap.source, SourceLayer::HermesSse);
    }
}
