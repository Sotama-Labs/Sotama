//! Jupiter v6 Swap API client. Two entry points:
//!
//!   • [`build_swap`] hits `/swap/v2/build` to get a relayable
//!     `swapInstruction` (programId + accounts + base64 data) ready to
//!     feed into [`crate::program::build_execute_swap_ix`]. The on-chain
//!     handler `invoke_signed`s the inner ix as the automation PDA.
//!   • [`quote`] hits `/swap/v1/quote` to read a price-discovery quote
//!     without the full ix payload — used by `price_watcher` for `Mint`
//!     side of `PriceRatio` triggers.
//!
//! ## Gotchas (carry-overs from the integration plan)
//!
//! * **CPI can't use ALTs.** The Sotama tx ends up at the 1232-byte
//!   limit if Jupiter's route uses too many accounts. We pass
//!   `maxAccounts=25` by default. If a route still comes back larger,
//!   the executor logs and bails — better to surface "no route under CPI
//!   account budget" than to silently lose the tx.
//! * **`taker` must be the automation PDA**, not the keeper signer.
//!   Jupiter signs the inner ix's transfer as `taker`; if we passed the
//!   keeper, the on-chain mint-check would reject (input ATA owner ≠
//!   PDA).
//! * **Route plan changes per call.** Don't cache `/build` responses
//!   across fires. The keeper re-quotes at every fire.
//! * **Wrap/unwrap SOL.** If input/output is SOL, the user's PDA must
//!   already hold wrapped SOL (the deposit-side wrap happens at
//!   create-tx time in the frontend). We currently ignore Jupiter's
//!   setupInstructions / cleanupInstructions.

use anyhow::{anyhow, Result};
use base64::Engine as _;
use reqwest::Client;
use serde::Deserialize;
use solana_sdk::{instruction::AccountMeta, pubkey::Pubkey};
use std::str::FromStr;

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
/// inner instruction data the keeper relays via CPI.
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

/// Maximum CPI accounts we accept. Lookup tables aren't usable inside a
/// CPI, so the entire route must fit in one v0 tx (≤ 1232 bytes ≈ 25
/// accounts plus the outer Sotama frame).
pub const MAX_CPI_ACCOUNTS: u16 = 25;

#[derive(Clone)]
pub struct JupiterClient {
    http: Client,
    base_url: String,
}

impl JupiterClient {
    pub fn new(http: Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
        }
    }

    /// Read-only price probe. Used by price_watcher's PriceRatio arm
    /// when one side of the ratio is a `PriceSource::Mint`. Returns
    /// `out_amount` (string-encoded u64) for `amount` of `input_mint`
    /// → `output_mint` at the requested slippage tolerance.
    pub async fn quote(
        &self,
        input_mint: &Pubkey,
        output_mint: &Pubkey,
        amount: u64,
        slippage_bps: u16,
    ) -> Result<QuoteResponse> {
        let url = format!(
            "{base}/swap/v1/quote?inputMint={input}&outputMint={output}&amount={amount}&slippageBps={bps}&onlyDirectRoutes=false",
            base = self.base_url.trim_end_matches('/'),
            input = input_mint,
            output = output_mint,
            amount = amount,
            bps = slippage_bps,
        );
        Ok(self
            .http
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    /// Build a relayable swap ix. `taker` MUST be the automation PDA
    /// (Jupiter signs the inner ix's transfers from this account, and
    /// our on-chain mint-check requires the input ATA to be PDA-owned).
    /// `max_accounts ≤ 25` keeps the relayed ix within the CPI budget.
    /// `only_direct_routes=true` forces a single-hop route, which keeps
    /// the account count low at the cost of a potentially worse price.
    pub async fn build_swap(
        &self,
        input_mint: &Pubkey,
        output_mint: &Pubkey,
        amount: u64,
        slippage_bps: u16,
        taker: &Pubkey,
        only_direct_routes: bool,
    ) -> Result<BuildResponse> {
        let url = format!(
            "{base}/swap/v2/build?inputMint={input}&outputMint={output}&amount={amount}&slippageBps={bps}&taker={taker}&maxAccounts={max_accounts}&onlyDirectRoutes={only_direct}",
            base = self.base_url.trim_end_matches('/'),
            input = input_mint,
            output = output_mint,
            amount = amount,
            bps = slippage_bps,
            taker = taker,
            max_accounts = MAX_CPI_ACCOUNTS,
            only_direct = only_direct_routes,
        );
        Ok(self
            .http
            .get(&url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?)
    }

    /// Build a CPI-compatible swap, falling back to `onlyDirectRoutes`
    /// if the multi-hop route returns more accounts than fit in the
    /// CPI budget. Jupiter treats `maxAccounts` as a soft hint, so the
    /// keeper has to enforce the cap on the response and re-quote.
    pub async fn build_swap_cpi_safe(
        &self,
        input_mint: &Pubkey,
        output_mint: &Pubkey,
        amount: u64,
        slippage_bps: u16,
        taker: &Pubkey,
    ) -> Result<BuildResponse> {
        let first = self
            .build_swap(input_mint, output_mint, amount, slippage_bps, taker, false)
            .await?;
        if first.swap_instruction.accounts.len() <= MAX_CPI_ACCOUNTS as usize {
            return Ok(first);
        }
        // Multi-hop route too wide — retry direct-only.
        let direct = self
            .build_swap(input_mint, output_mint, amount, slippage_bps, taker, true)
            .await?;
        if direct.swap_instruction.accounts.len() > MAX_CPI_ACCOUNTS as usize {
            return Err(anyhow!(
                "no CPI-compatible Jupiter route for {input_mint} → {output_mint} (multi-hop: {} accts, direct: {} accts; cap is {})",
                first.swap_instruction.accounts.len(),
                direct.swap_instruction.accounts.len(),
                MAX_CPI_ACCOUNTS,
            ));
        }
        Ok(direct)
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
