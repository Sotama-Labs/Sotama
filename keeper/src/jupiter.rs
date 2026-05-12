//! Jupiter Swap API (V2 Meta-Aggregator) client. Two entry points:
//!
//!   • [`JupiterClient::build_swap`] hits `/swap/v2/build` to get a
//!     relayable `swapInstruction` (programId + accounts + base64 data)
//!     plus the route's published address-lookup-tables, ready to feed
//!     into a versioned (v0) outer tx that wraps the swap via Sotama's
//!     `execute_swap` relay.
//!   • [`JupiterClient::quote`] hits `/swap/v2/build` with a minimal
//!     synthetic taker to read a price-discovery quote — used by the
//!     `price_watcher`'s `Mint` side of `PriceRatio` triggers. The
//!     deprecated `/swap/v1/quote` (Metis) endpoint has been retired.
//!
//! ## Account-budget model
//!
//! The 1232-byte wire-serialized cap on a Solana v0 transaction is the
//! binding constraint, not the raw `accounts.len()` of the inner ix.
//! When Jupiter's route resolves accounts via published ALTs, each
//! ALT-resident pubkey costs ~1 byte (table index) instead of 32 bytes
//! (inline). The keeper consumes `addressesByLookupTableAddress` from
//! the build response, resolves the ALT account data via
//! `getMultipleAccounts` (cached), and compiles the outer tx as a v0
//! `MessageV0`. The serialized-size check at the executor's tx-send
//! site (`<= 1232`) is what enforces the real cap; this client no
//! longer hard-rejects on a raw account count.
//!
//! ## Other invariants
//!
//! * **`taker` must be the automation PDA** for `/build`, not the
//!   keeper signer. Jupiter signs the inner ix's transfers from this
//!   account, and the on-chain mint-check requires the input ATA to be
//!   PDA-owned.
//! * **Route plan changes per call.** Don't cache `/build` responses
//!   across fires. The keeper re-quotes at every fire.
//! * **Wrap/unwrap SOL.** If input/output is SOL, the user's PDA must
//!   already hold wrapped SOL (the deposit-side wrap happens at
//!   create-tx time in the frontend). We currently ignore Jupiter's
//!   setupInstructions / cleanupInstructions.
//! * **Auth.** The Developer tier requires `x-api-key` on every call;
//!   the `JupiterClient` is constructed with the optional key and
//!   attaches the header when present. On 429 the client sleeps with
//!   jittered backoff and retries up to twice — at 10 rpm even brief
//!   bursts can trip the limit, so the calling code should also share
//!   results via `PriceCache`/`MintPriceCache`/`LookupTableCache`
//!   rather than re-fetch.

use anyhow::{anyhow, Result};
use base64::Engine as _;
use reqwest::{Client, RequestBuilder, StatusCode};
use serde::Deserialize;
use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey};
use std::collections::HashMap;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{debug, warn};

/// Minimum quote response we care about. Jupiter returns many more
/// fields (routePlan, contextSlot, priceImpactPct, etc.); we only
/// deserialize what we use to keep the type stable across API drift.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuoteResponse {
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    /// Worst-case out_amount honoring slippageBps.
    pub other_amount_threshold: String,
    /// Optional route plan; if present, the length is the hop count.
    #[serde(default)]
    pub route_plan: Vec<serde_json::Value>,
}

/// `/swap/v2/build` response. Like QuoteResponse but with the actual
/// inner instruction data the keeper relays via CPI plus the address
/// lookup tables the route resolves against.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildResponse {
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: String,
    pub out_amount: String,
    pub other_amount_threshold: String,
    pub swap_instruction: ApiInstruction,
    /// Optional setup ixs (e.g., create wSOL ATA, wrap SOL). We ignore
    /// these for now; the deposit-side wrap is handled at create-tx
    /// time in the frontend.
    #[serde(default)]
    pub setup_instructions: Vec<ApiInstruction>,
    /// Optional cleanup ixs (e.g., unwrap residual SOL).
    #[serde(default)]
    pub cleanup_instruction: Option<ApiInstruction>,
    /// Address-lookup-tables Jupiter's route references. Map of
    /// `<table_pubkey>` → `[<address_in_table>, …]`. The executor
    /// resolves each table via the shared `LookupTableCache`, then
    /// includes the resulting `AddressLookupTableAccount`s in the
    /// compiled v0 outer tx. Without this, ALT-resident accounts have
    /// to be inlined and the 1232-byte cap bites.
    #[serde(default)]
    pub addresses_by_lookup_table_address: HashMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiInstruction {
    pub program_id: String,
    pub accounts: Vec<ApiAccount>,
    /// Base64-encoded ix data.
    pub data: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiAccount {
    pub pubkey: String,
    pub is_signer: bool,
    pub is_writable: bool,
}

/// Soft hint to Jupiter for the maximum accounts in a route. Jupiter
/// treats this as advisory; the real cap is the 1232-byte v0 wire-size
/// limit enforced at the executor's compile/serialize site. Empirically
/// on mainnet, hint=30 returns ~34-41 account routes for SOL↔USDC and
/// similar majors; with ALT compression covering ~60-70% of accounts,
/// the inline residual is ~10-15 accounts, comfortably under the wire
/// cap. Raising the hint causes Jupiter to pick deeper routes that
/// blow the cap even with ALTs; lowering it pushes Jupiter onto thinner
/// liquidity with worse fills.
// Per Jupiter docs (https://dev.jup.ag/docs/swap/build/common-instructions
// — "CPI considerations"), CPI-relayed Jupiter swaps CANNOT use Address
// Lookup Tables. Without ALT compression, every account in Jupiter's
// route lands inline in the v0 tx (~32 bytes each).
//
// The `maxAccounts` query param is a HINT, not a binding cap — Jupiter
// frequently exceeds it when routing requires it (observed: hint=16 →
// 33 accounts returned; hint=12 → 22 accounts returned). The keeper's
// outer ix adds 6 prefix accounts + ix data (~200 bytes) + 1 signature
// + headers, leaving ~1000 bytes for inline accounts (~31 max).
//
// We set the hint to 12 so Jupiter targets ~22 accounts, giving us
// 22 + 6 = 28 accounts ≈ 900 bytes + 200 byte ix data + headers, which
// fits comfortably under the 1232-byte wire cap. Going lower (e.g. 8)
// often returns "No routes found" because the router can't find a
// path with that few accounts.
pub const JUPITER_MAX_ACCOUNTS_HINT: u16 = 12;

/// Number of 429 retries before bubbling the error. At 10 rpm even a
/// brief burst can trip the limit, so the client backs off rather than
/// failing the fire immediately. Combined with the result-sharing
/// caches (PriceCache, MintPriceCache, LookupTableCache), steady-state
/// load should sit well under the rate limit; the retry budget is for
/// transient bursts (e.g., 3 rules all fire in the same second).
const RATE_LIMIT_RETRIES: u32 = 2;

#[derive(Clone)]
pub struct JupiterClient {
    http: Client,
    base_url: String,
    api_key: Option<String>,
}

impl JupiterClient {
    pub fn new(http: Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
            api_key: None,
        }
    }

    /// Attach the Developer/Pro tier API key. Sent as `x-api-key` on
    /// every quote/build call.
    pub fn with_api_key(mut self, api_key: Option<String>) -> Self {
        self.api_key = api_key.filter(|s| !s.is_empty());
        self
    }

    /// Apply the `x-api-key` header when configured. No-op otherwise so
    /// the same client works on the free `lite-api.jup.ag` host.
    fn auth(&self, req: RequestBuilder) -> RequestBuilder {
        match &self.api_key {
            Some(key) => req.header("x-api-key", key),
            None => req,
        }
    }

    /// Run a GET that 429-retries with jittered backoff. Other status
    /// codes propagate to the caller via `error_for_status()`.
    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response> {
        let mut attempt = 0u32;
        loop {
            let req = self.auth(self.http.get(url));
            let resp = req
                .send()
                .await
                .map_err(|e| anyhow!("jupiter GET {url}: {e}"))?;
            if resp.status() != StatusCode::TOO_MANY_REQUESTS || attempt >= RATE_LIMIT_RETRIES {
                return resp
                    .error_for_status()
                    .map_err(|e| anyhow!("jupiter status: {e}"));
            }
            let base = 250u64 << attempt; // 250ms, 500ms
            let jitter = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| (d.subsec_nanos() % 200) as u64)
                .unwrap_or(0);
            let sleep_ms = base + jitter;
            warn!(
                attempt,
                sleep_ms,
                url,
                "jupiter 429; backing off"
            );
            tokio::time::sleep(Duration::from_millis(sleep_ms)).await;
            attempt += 1;
        }
    }

    /// Read-only price probe. Used by `price_watcher`'s `PriceRatio` arm
    /// when one side of the ratio is a `PriceSource::Mint`. Hits
    /// `/swap/v2/build` with a synthetic system-program taker so we get
    /// the quote fields (`in_amount` / `out_amount`) without paying the
    /// account-resolution cost of a real-taker build — the returned
    /// instruction payload is discarded by the caller. The deprecated
    /// `/swap/v1/quote` (Metis) endpoint is no longer used.
    pub async fn quote(
        &self,
        input_mint: &Pubkey,
        output_mint: &Pubkey,
        amount: u64,
        slippage_bps: u16,
    ) -> Result<QuoteResponse> {
        // System program ID is a valid pubkey that resolves to a
        // well-known account and produces a stable build response.
        let synthetic_taker = "11111111111111111111111111111111";
        let url = format!(
            "{base}/swap/v2/build?inputMint={input}&outputMint={output}&amount={amount}&slippageBps={bps}&taker={taker}&maxAccounts={max_accounts}",
            base = self.base_url.trim_end_matches('/'),
            input = input_mint,
            output = output_mint,
            amount = amount,
            bps = slippage_bps,
            taker = synthetic_taker,
            max_accounts = JUPITER_MAX_ACCOUNTS_HINT,
        );
        let resp = self.get_with_retry(&url).await?;
        let build: BuildResponse = resp
            .json()
            .await
            .map_err(|e| anyhow!("jupiter /build (quote) decode: {e}"))?;
        Ok(QuoteResponse {
            input_mint: build.input_mint,
            output_mint: build.output_mint,
            in_amount: build.in_amount,
            out_amount: build.out_amount,
            other_amount_threshold: build.other_amount_threshold,
            route_plan: Vec::new(),
        })
    }

    /// Build a relayable swap ix. `taker` MUST be the automation PDA
    /// (Jupiter signs the inner ix's transfers from this account, and
    /// our on-chain mint-check requires the input ATA to be PDA-owned).
    /// `maxAccounts` is passed as a soft hint; the actual cap is the
    /// 1232-byte v0 wire-size limit, enforced at the executor's
    /// post-compile serialize check.
    pub async fn build_swap(
        &self,
        input_mint: &Pubkey,
        output_mint: &Pubkey,
        amount: u64,
        slippage_bps: u16,
        taker: &Pubkey,
        destination_token_account: Option<&Pubkey>,
    ) -> Result<BuildResponse> {
        // Default route: Jupiter sends output to `taker`'s output-mint ATA.
        // Sotama swaps run with taker=PDA but the on-chain `execute_swap`
        // ix requires `output_ata.owner == destination` (a separate wallet).
        // So we explicitly pass `destinationTokenAccount` to redirect
        // Jupiter's CPI into the right ATA — otherwise locate_ata_indices()
        // fails with "output ATA … missing from Jupiter accounts" and the
        // executor bails before submission.
        let dest_param = destination_token_account
            .map(|ata| format!("&destinationTokenAccount={ata}"))
            .unwrap_or_default();
        let url = format!(
            "{base}/swap/v2/build?inputMint={input}&outputMint={output}&amount={amount}&slippageBps={bps}&taker={taker}&maxAccounts={max_accounts}{dest_param}",
            base = self.base_url.trim_end_matches('/'),
            input = input_mint,
            output = output_mint,
            amount = amount,
            bps = slippage_bps,
            taker = taker,
            max_accounts = JUPITER_MAX_ACCOUNTS_HINT,
        );
        let resp = self.get_with_retry(&url).await?;
        let parsed: BuildResponse = resp
            .json()
            .await
            .map_err(|e| anyhow!("jupiter /build decode: {e}"))?;
        debug!(
            inner_accounts = parsed.swap_instruction.accounts.len(),
            alt_count = parsed.addresses_by_lookup_table_address.len(),
            "jupiter /build ok"
        );
        Ok(parsed)
    }
}

/// Convert Jupiter's wire format to the Solana SDK types we relay.
pub fn into_account_metas(api_accounts: &[ApiAccount]) -> Result<Vec<AccountMeta>> {
    api_accounts
        .iter()
        .map(|a| {
            Ok(AccountMeta {
                pubkey: Pubkey::from_str(&a.pubkey)
                    .map_err(|e| anyhow!("bad pubkey `{}`: {e}", a.pubkey))?,
                is_signer: a.is_signer,
                is_writable: a.is_writable,
            })
        })
        .collect()
}

/// Find the indices of the PDA's input ATA and the destination's output
/// ATA in the inner-ix accounts list. Returns `Err` if either is
/// missing — the route shape doesn't match our expectations and we
/// must bail before submitting the tx.
pub fn locate_ata_indices(
    accounts: &[AccountMeta],
    input_ata: &Pubkey,
    output_ata: &Pubkey,
) -> Result<(u8, u8)> {
    let i = accounts
        .iter()
        .position(|a| a.pubkey == *input_ata)
        .ok_or_else(|| anyhow!("input ATA {input_ata} missing from Jupiter accounts"))?;
    let o = accounts
        .iter()
        .position(|a| a.pubkey == *output_ata)
        .ok_or_else(|| anyhow!("output ATA {output_ata} missing from Jupiter accounts"))?;
    if i > u8::MAX as usize || o > u8::MAX as usize {
        return Err(anyhow!("Jupiter returned > 255 accounts; impossible under CPI"));
    }
    Ok((i as u8, o as u8))
}

/// Decode the base64 ix data returned by `/swap/v2/build`.
pub fn decode_inner_data(data_b64: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(data_b64)
        .map_err(|e| anyhow!("base64 decode swap_instruction.data: {e}"))
}

/// Parse Jupiter's `addressesByLookupTableAddress` map into a flat
/// `Vec<Pubkey>` of distinct table addresses. The executor passes these
/// to `LookupTableCache::resolve_many` to get `AddressLookupTableAccount`
/// objects ready for v0 message compilation.
pub fn lookup_table_pubkeys(
    addresses_by_lookup_table_address: &HashMap<String, Vec<String>>,
) -> Result<Vec<Pubkey>> {
    addresses_by_lookup_table_address
        .keys()
        .map(|s| Pubkey::from_str(s).map_err(|e| anyhow!("bad ALT pubkey `{s}`: {e}")))
        .collect()
}
