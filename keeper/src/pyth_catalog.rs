//! Cached map of 32-byte Pyth feed ids → Lazer/Hermes metadata.
//!
//! Used by `jupiter_watcher` and `price_watcher` to disambiguate the
//! AssetPrice trigger's `quote_mint` field at fire time: a 32-byte
//! value that may be EITHER an SPL mint (probe via Jupiter) OR a Pyth
//! feed id (fetch via Hermes). Catalog hit → Pyth path; miss → existing
//! Jupiter probe. Source: same `/v1/symbols` endpoint `lazer_watcher`
//! uses for its base-feed translation, so the dispatch is consistent
//! across all three watchers.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;

const SYMBOLS_URL: &str = "https://history.pyth-lazer.dourolabs.app/v1/symbols";

/// Per-feed metadata keyed by the 32-byte Hermes feed id (same bytes
/// the on-chain AssetPrice trigger stores in either `feed: Pubkey` or
/// `quote_mint: Option<Pubkey>` when the quote is a Pyth-listed asset
/// without a Solana SPL mint).
#[derive(Debug, Clone)]
#[allow(dead_code)] // fields preserved for an eventual lazer_watcher refactor
pub struct PythFeedMeta {
    pub lazer_id: u32,
    pub exponent: i32,
}

pub type PythCatalog = HashMap<[u8; 32], PythFeedMeta>;

/// Fetch the canonical Pyth catalog. Best-effort: callers should treat
/// failure as an empty catalog (no Pyth-feed quote support, fall back
/// to Jupiter-mint dispatch only).
pub async fn fetch() -> Result<PythCatalog> {
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

    let mut out = HashMap::with_capacity(rows.len());
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
        out.insert(
            arr,
            PythFeedMeta {
                lazer_id: r.pyth_lazer_id,
                exponent: r.exponent,
            },
        );
    }
    Ok(out)
}
