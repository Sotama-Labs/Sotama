//! Signing abstraction for the keeper.
//!
//! Two implementations:
//!   • `LocalKeypairSigner`  — reads a Solana keypair file. Dev only.
//!   • `TurnkeySigner`       — calls Turnkey's REST API for each sign,
//!                             keeping the raw private key inside their HSM.
//!
//! The concrete signer is selected by env at startup
//! (`KeeperConfig::load_signer`). Production deploys (Fly.io / mainnet)
//! must use Turnkey; the local-keypair path stays for `pnpm anchor:e2e:devnet`
//! and developer machines.
//!
//! Turnkey API basics (verify against current docs before enabling in prod):
//!   • Auth: every request body is SHA-256-hashed, the digest is signed
//!     with a P-256 ECDSA "stamper" key, and the signature + public key
//!     are wrapped in a JSON stamp passed via the `X-Stamp` header
//!     (base64url encoded).
//!   • Sign endpoint: POST /public/v1/submit/sign_raw_payload with
//!     activity type `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2`.
//!   • For Solana ed25519 keys, set
//!     `encoding = PAYLOAD_ENCODING_HEXADECIMAL`,
//!     `hashFunction = HASH_FUNCTION_NOT_APPLICABLE` (Solana's signature
//!     scheme already covers the message digest), and pass the message
//!     bytes as a hex string.
//!   • Activity returns `r` and `s` separately; concatenate to a 64-byte
//!     signature.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use base64::Engine as _;
use p256::ecdsa::{signature::Signer as P256SignerTrait, Signature as P256Signature, SigningKey};
use serde::Deserialize;
use serde_json::json;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signature, Signer as SolanaSignerTrait};
use std::path::Path;
use std::str::FromStr;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Sotama-keeper-shaped signer. Boxed (`dyn`) at the call site so tests
/// and prod can swap between local keypairs and Turnkey transparently.
#[async_trait]
pub trait KeeperSigner: Send + Sync {
    fn pubkey(&self) -> Pubkey;

    /// Sign the bytes of a serialized Solana `Message` (i.e.
    /// `tx.message_data()`). Returns the 64-byte ed25519 signature
    /// ready to slot into `tx.signatures[0]`.
    async fn sign_message(&self, message_bytes: &[u8]) -> Result<Signature>;
}

/* ── Local keypair ──────────────────────────────────────────────────── */

pub struct LocalKeypairSigner {
    keypair: Keypair,
    pubkey: Pubkey,
}

impl LocalKeypairSigner {
    pub fn from_path(path: impl AsRef<Path>) -> Result<Self> {
        let keypair = solana_sdk::signature::read_keypair_file(path.as_ref())
            .map_err(|e| anyhow!("read keypair {}: {e}", path.as_ref().display()))?;
        let pubkey = keypair.pubkey();
        Ok(Self { keypair, pubkey })
    }
}

#[async_trait]
impl KeeperSigner for LocalKeypairSigner {
    fn pubkey(&self) -> Pubkey {
        self.pubkey
    }

    async fn sign_message(&self, message_bytes: &[u8]) -> Result<Signature> {
        Ok(self.keypair.sign_message(message_bytes))
    }
}

/* ── Turnkey ────────────────────────────────────────────────────────── */

pub struct TurnkeyConfig {
    pub api_base: String,
    /// SEC1-uncompressed P-256 public key, hex-encoded (66 chars: `04` + 64).
    pub api_public_key: String,
    /// PKCS#8 / raw P-256 private scalar, hex-encoded (64 chars).
    pub api_private_key_hex: String,
    pub organization_id: String,
    /// Turnkey private-key resource ID for the Solana ed25519 key.
    pub private_key_id: String,
    /// Solana pubkey corresponding to `private_key_id`. Cached so we
    /// don't round-trip Turnkey on every transaction.
    pub solana_pubkey: Pubkey,
}

pub struct TurnkeySigner {
    http: reqwest::Client,
    api_base: String,
    api_public_key: String,
    stamper: SigningKey,
    organization_id: String,
    private_key_id: String,
    solana_pubkey: Pubkey,
}

impl TurnkeySigner {
    pub fn new(cfg: TurnkeyConfig) -> Result<Self> {
        let bytes = hex::decode(cfg.api_private_key_hex.trim_start_matches("0x"))
            .map_err(|e| anyhow!("invalid TURNKEY_API_PRIVATE_KEY hex: {e}"))?;
        let stamper = SigningKey::from_slice(&bytes)
            .map_err(|e| anyhow!("invalid p256 secret: {e}"))?;

        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()?,
            api_base: cfg.api_base,
            api_public_key: cfg.api_public_key,
            stamper,
            organization_id: cfg.organization_id,
            private_key_id: cfg.private_key_id,
            solana_pubkey: cfg.solana_pubkey,
        })
    }

    pub fn from_env() -> Result<Self> {
        let api_base = std::env::var("TURNKEY_API_BASE")
            .unwrap_or_else(|_| "https://api.turnkey.com".to_string());
        let api_public_key = required("TURNKEY_API_PUBLIC_KEY")?;
        let api_private_key_hex = required("TURNKEY_API_PRIVATE_KEY")?;
        let organization_id = required("TURNKEY_ORGANIZATION_ID")?;
        let private_key_id = required("TURNKEY_PRIVATE_KEY_ID")?;
        let pubkey_str = required("KEEPER_PUBKEY")?;
        let solana_pubkey = Pubkey::from_str(&pubkey_str)
            .map_err(|e| anyhow!("invalid KEEPER_PUBKEY `{pubkey_str}`: {e}"))?;
        Self::new(TurnkeyConfig {
            api_base,
            api_public_key,
            api_private_key_hex,
            organization_id,
            private_key_id,
            solana_pubkey,
        })
    }

    fn build_stamp(&self, body: &str) -> Result<String> {
        // The `signature::Signer` impl on SigningKey hashes the input
        // with SHA-256 internally, so passing the body bytes is correct
        // for Turnkey's stamper convention.
        let signature: P256Signature = self.stamper.sign(body.as_bytes());
        let stamp = json!({
            "publicKey": self.api_public_key,
            "scheme": "SIGNATURE_SCHEME_TK_API_P256",
            "signature": hex::encode(signature.to_der().as_bytes()),
        });
        Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(stamp.to_string()))
    }

    fn timestamp_ms() -> Result<String> {
        Ok(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| anyhow!("system clock: {e}"))?
            .as_millis()
            .to_string())
    }
}

#[async_trait]
impl KeeperSigner for TurnkeySigner {
    fn pubkey(&self) -> Pubkey {
        self.solana_pubkey
    }

    async fn sign_message(&self, message_bytes: &[u8]) -> Result<Signature> {
        let body = json!({
            "type": "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
            "timestampMs": Self::timestamp_ms()?,
            "organizationId": self.organization_id,
            "parameters": {
                "signWith": self.private_key_id,
                "payload": hex::encode(message_bytes),
                "encoding": "PAYLOAD_ENCODING_HEXADECIMAL",
                "hashFunction": "HASH_FUNCTION_NOT_APPLICABLE",
            },
        });
        let body_str = serde_json::to_string(&body)?;
        let stamp = self.build_stamp(&body_str)?;

        let url = format!("{}/public/v1/submit/sign_raw_payload", self.api_base);
        let resp = self
            .http
            .post(&url)
            .header("X-Stamp", stamp)
            .header("Content-Type", "application/json")
            .body(body_str)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            // Turnkey returns useful detail in the body on 4xx — policy
            // name, missing approver, stale stamp, etc. Surface it so
            // the keeper logs explain WHY the sign was rejected
            // instead of just "403 Forbidden".
            let text = resp
                .text()
                .await
                .unwrap_or_else(|e| format!("<no body: {e}>"));
            return Err(anyhow!(
                "turnkey http {}: {}",
                status.as_u16(),
                text.trim()
            ));
        }
        let parsed: SignRawPayloadResponse = resp.json().await?;

        let activity = parsed
            .activity
            .ok_or_else(|| anyhow!("turnkey: no activity in response"))?;
        // Pending activities mean a policy held the request for human
        // approval — the keeper can't proceed in that case. Either fix
        // the policy to auto-approve our scope, or treat as a failure
        // and reschedule.
        if activity.status != "ACTIVITY_STATUS_COMPLETED" {
            return Err(anyhow!(
                "turnkey: activity status `{}`; expected ACTIVITY_STATUS_COMPLETED",
                activity.status
            ));
        }
        let result = activity
            .result
            .and_then(|r| r.sign_raw_payload_result)
            .ok_or_else(|| anyhow!("turnkey: missing signRawPayloadResult"))?;
        let r_bytes = hex::decode(&result.r)
            .map_err(|e| anyhow!("turnkey r decode: {e}"))?;
        let s_bytes = hex::decode(&result.s)
            .map_err(|e| anyhow!("turnkey s decode: {e}"))?;
        if r_bytes.len() != 32 || s_bytes.len() != 32 {
            return Err(anyhow!(
                "turnkey: ed25519 signature parts must be 32 bytes (got r={}, s={})",
                r_bytes.len(),
                s_bytes.len()
            ));
        }
        let mut sig = [0u8; 64];
        sig[..32].copy_from_slice(&r_bytes);
        sig[32..].copy_from_slice(&s_bytes);
        Signature::try_from(&sig[..])
            .map_err(|e| anyhow!("solana signature decode: {e}"))
    }
}

#[derive(Debug, Deserialize)]
struct SignRawPayloadResponse {
    activity: Option<TurnkeyActivity>,
}

#[derive(Debug, Deserialize)]
struct TurnkeyActivity {
    status: String,
    result: Option<TurnkeyActivityResult>,
}

#[derive(Debug, Deserialize)]
struct TurnkeyActivityResult {
    #[serde(rename = "signRawPayloadResult")]
    sign_raw_payload_result: Option<SignRawPayloadResult>,
}

#[derive(Debug, Deserialize)]
struct SignRawPayloadResult {
    r: String,
    s: String,
}

fn required(name: &str) -> Result<String> {
    std::env::var(name).map_err(|_| anyhow!("missing required env var {name}"))
}

/* ── Selection ──────────────────────────────────────────────────────── */

/// Pick the right signer from env. Prefers Turnkey when its API public
/// key is configured (and non-empty); falls back to the local keypair
/// file otherwise. The non-empty check lets the .env carry empty
/// placeholder lines without forcing the Turnkey path.
pub fn load_signer() -> Result<std::sync::Arc<dyn KeeperSigner>> {
    let turnkey_set = std::env::var("TURNKEY_API_PUBLIC_KEY")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if turnkey_set {
        let signer = TurnkeySigner::from_env()?;
        Ok(std::sync::Arc::new(signer))
    } else {
        let path = required("KEEPER_KEYPAIR_PATH")?;
        let signer = LocalKeypairSigner::from_path(&path)?;
        Ok(std::sync::Arc::new(signer))
    }
}
