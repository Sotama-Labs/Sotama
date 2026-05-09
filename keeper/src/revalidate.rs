//! Mid-queue trigger revalidation.
//!
//! When the executor processes multiple users' automations triggered by
//! the same event (e.g. five SOL-below-$X rules crossing together), it
//! fires them serially in `(created_at, nonce)` order. Between fires,
//! it asks this module "is the trigger condition STILL satisfied?" so a
//! late user is skipped if the upstream condition no longer holds —
//! e.g. price bounced back above threshold after user 1's rule
//! executed.
//!
//! Per trigger kind:
//!   * `AssetPrice`    — re-poll Pyth Hermes (and Jupiter for non-USD
//!     quotes) and re-evaluate the comparator. This is the trigger
//!     where revalidation matters most: tens of seconds between fires
//!     can see meaningful price moves.
//!   * `AccountActivity` — always returns true. The trigger is
//!     event-based: a watched-account tx already happened, there's no
//!     condition to re-evaluate.
//!
//! Linked-rule fires (`depth > 0`) skip revalidation: linked chains
//! already serialize through the upstream's success and have their own
//! `MAX_LINK_FEE_LAMPORTS` cap on-chain.

use anyhow::Result;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use std::sync::Arc;
use tracing::debug;

use crate::jupiter::JupiterClient;
use crate::price_watcher::{
    crossed_above, crossed_below, fetch_prices, probe_mint, pubkey_to_hex, ratio_compare,
};
use crate::state::TriggerSpec;
use crate::types::AutomationCtx;

/// Shared state needed to revalidate any trigger kind. Built once per
/// event task; cheap to clone (all fields are Arc'd or owned strings).
pub struct RevalidateCtx {
    pub http: reqwest::Client,
    pub rpc: Arc<RpcClient>,
    pub hermes_url: String,
    pub jupiter: JupiterClient,
    pub swap_slippage_bps: u16,
}

/// Returns `true` if the trigger condition for `ctx` is currently
/// satisfied — i.e. firing this automation right now is justified by
/// the upstream condition. Returns `false` if the condition has lapsed
/// since the original watcher signal.
///
/// Errors propagate (treat as "skip but warn") only on infrastructure
/// failure (RPC down, Pyth Hermes 5xx). The caller should treat
/// errors as "fire anyway and let on-chain enforce" rather than
/// silently dropping the user — better to fire spuriously than to
/// drop a valid rule due to a transient network blip.
pub async fn revalidate(rev: &RevalidateCtx, ctx: &AutomationCtx) -> Result<bool> {
    match &ctx.trigger {
        TriggerSpec::AccountActivity { .. } => Ok(true),
        // Once due, the time condition stays true forever — there's
        // nothing to "un-cross". The on-chain `cadence::Once` flip to
        // finished is what stops re-fires; revalidate just waves it
        // through.
        TriggerSpec::TimeElapsed { .. } => Ok(true),
        TriggerSpec::AssetPrice {
            feed,
            quote_mint,
            comparator,
            threshold,
            expo,
            source,
        } => revalidate_asset_price(
            rev,
            feed,
            quote_mint,
            *comparator,
            *threshold,
            *expo,
            *source,
        )
        .await,
    }
}

async fn revalidate_asset_price(
    rev: &RevalidateCtx,
    feed: &Pubkey,
    quote_mint: &Option<Pubkey>,
    comparator: u8,
    threshold: i64,
    expo: i32,
    source: u8,
) -> Result<bool> {
    let price = match source {
        crate::state::oracle_source::PYTH => {
            let feed_hex = pubkey_to_hex(feed);
            let prices = fetch_prices(&rev.http, &rev.hermes_url, &[feed_hex.clone()]).await?;
            match prices.get(&feed_hex).cloned() {
                Some(p) => p,
                None => {
                    debug!(feed = %feed, "revalidate: hermes returned no price; passing through");
                    return Ok(true);
                }
            }
        }
        crate::state::oracle_source::JUPITER => {
            // `feed` is an SPL mint when source = JUPITER. The watcher
            // path is authoritative here; revalidate trusts the watcher's
            // green light and lets the fire proceed without a second
            // probe (Jupiter rate-limits favor conservative usage).
            return Ok(true);
        }
        unknown => {
            debug!(source = unknown, "revalidate: unknown oracle source; passing through");
            return Ok(true);
        }
    };
    let still = match quote_mint {
        None => match comparator {
            0 => crossed_below(&price, threshold, expo),
            1 => crossed_above(&price, threshold, expo),
            _ => return Ok(true),
        },
        Some(qm) => {
            // Re-probe Jupiter for the quote mint. If the probe fails,
            // fall through to "fire anyway" rather than blocking on a
            // transient quote outage.
            match probe_mint(&rev.jupiter, qm, rev.swap_slippage_bps).await {
                Ok(q) => ratio_compare(
                    comparator,
                    (price.raw as i128, price.expo),
                    (q.out_amount as i128, -6),
                    threshold,
                    expo,
                )
                .unwrap_or(true),
                Err(e) => {
                    debug!(mint = %qm, error = %e, "revalidate: jupiter quote failed; passing through");
                    true
                }
            }
        }
    };
    Ok(still)
}
