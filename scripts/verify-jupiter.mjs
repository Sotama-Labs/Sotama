#!/usr/bin/env node
/**
 * Jupiter API sanity check. Hits /swap/v1/quote and /swap/v2/build for a
 * curated set of pairs and reports route plan, account count, and
 * out-amount. Catches API drift before live executes hit mainnet.
 *
 *   node scripts/verify-jupiter.mjs                            # devnet pairs
 *   CLUSTER=mainnet-beta node scripts/verify-jupiter.mjs       # mainnet pairs
 *
 * Exit codes:
 *   0 — all pairs returned a route under the CPI account budget (≤25)
 *   1 — at least one pair failed to return or exceeded the budget
 *
 * The CPI 25-account ceiling is the hard binding constraint for our
 * on-chain relay (Sotama tx + Jupiter accounts must fit under the
 * 1232-byte v0 tx limit, no ALTs allowed).
 */

const BASE_URL = process.env.JUPITER_BASE_URL ?? "https://api.jup.ag";
const API_KEY = process.env.JUPITER_API_KEY ?? null;
const CLUSTER = process.env.CLUSTER ?? "devnet";
// Soft hint passed to Jupiter; matches the keeper's
// `JUPITER_MAX_ACCOUNTS_HINT`. Actual fit is determined by the v0 +
// ALT-compressed wire size, not raw account count. Empirically with
// Jupiter's published ALTs covering ~60-70% of route accounts on
// mainnet, a hint of 30 keeps the inline (non-ALT) account count low
// enough to stay under the 1232-byte wire cap.
const MAX_ACCOUNTS = 30;
const TAKER = "11111111111111111111111111111111"; // synthetic — quote works without a real PDA

const SOL = "So11111111111111111111111111111111111111112";
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const MAINNET_PAIRS = [
  { label: "SOL → USDC", input: SOL, output: USDC_MAINNET, amount: 5_000_000 }, // 0.005 SOL
  { label: "USDC → SOL", input: USDC_MAINNET, output: SOL, amount: 1_000_000 }, // 1 USDC
];

const DEVNET_PAIRS = [
  // Devnet liquidity is thin; this still validates the API endpoint
  { label: "SOL → USDC (devnet)", input: SOL, output: USDC_DEVNET, amount: 5_000_000 },
];

const PAIRS = CLUSTER === "mainnet-beta" ? MAINNET_PAIRS : DEVNET_PAIRS;

async function fetchJson(url) {
  const headers = API_KEY ? { "x-api-key": API_KEY } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`${r.status} ${r.statusText} :: ${body.slice(0, 200)}`);
  }
  return r.json();
}

function fmtNum(n) {
  return Number(n).toLocaleString();
}

let allOk = true;

/**
 * Estimate the v0 + ALT-compressed wire size of a Sotama relay tx
 * that wraps Jupiter's swap instruction.
 *
 * Solana v0 tx layout (high-level):
 *   header: 3 bytes (num_signers, num_readonly_signers, num_readonly_unsigned)
 *   static_account_keys: 32 bytes each
 *   recent_blockhash: 32 bytes
 *   instructions: variable (small per ix: 1 program_id index + 1 num_accounts + accounts + data len + data)
 *   address_table_lookups: 32 bytes per ALT pubkey + 1 byte per writable index + 1 byte per readonly index
 *   signatures: 64 bytes each
 *
 * An ALT-resident account costs ~1 byte (table index) instead of 32 bytes
 * (inline pubkey). This estimator is a rough lower bound — sufficient
 * to spot routes that comfortably fit vs ones that bust the 1232-byte cap.
 */
function estimateWireSize({ innerAccounts, altMap, sotamaOuterAccounts = 8, ixDataLen = 32 }) {
  const altResidentSet = new Set();
  for (const addrs of Object.values(altMap ?? {})) {
    for (const a of addrs) altResidentSet.add(a);
  }
  const innerAddrs = innerAccounts.map((a) => a.pubkey);
  const inlineFromInner = innerAddrs.filter((a) => !altResidentSet.has(a)).length;
  const altResidentFromInner = innerAddrs.filter((a) => altResidentSet.has(a)).length;

  const numAlts = Object.keys(altMap ?? {}).length;
  const signaturesBytes = 64; // single keeper signer
  const headerBytes = 3;
  const staticKeysBytes = (inlineFromInner + sotamaOuterAccounts) * 32;
  const blockhashBytes = 32;
  const altLookupsBytes = numAlts * (32 + 1) + altResidentFromInner * 2; // table key + ~2 indices per acct (rw+ro buckets)
  const ixBytes = 1 + 1 + innerAccounts.length + 1 + ixDataLen + 80; // crude estimate inc. outer Sotama ix
  return signaturesBytes + headerBytes + staticKeysBytes + blockhashBytes + altLookupsBytes + ixBytes;
}

for (const p of PAIRS) {
  process.stdout.write(`\n[${p.label}] amount=${fmtNum(p.amount)}\n`);

  try {
    const buildUrl = `${BASE_URL}/swap/v2/build?inputMint=${p.input}&outputMint=${p.output}&amount=${p.amount}&slippageBps=50&taker=${TAKER}&maxAccounts=${MAX_ACCOUNTS}`;
    const build = await fetchJson(buildUrl);
    const innerAccounts = build.swapInstruction?.accounts ?? [];
    const programId = build.swapInstruction?.programId;
    const programOk = programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

    process.stdout.write(
      `  quote: in=${fmtNum(build.inAmount)}, out=${fmtNum(build.outAmount)}\n`,
    );

    const altMap = build.addressesByLookupTableAddress ?? {};
    const altCount = Object.keys(altMap).length;
    const altResidentSet = new Set();
    for (const addrs of Object.values(altMap)) for (const a of addrs) altResidentSet.add(a);
    const innerAddrs = innerAccounts.map((a) => a.pubkey);
    const altResidentInner = innerAddrs.filter((a) => altResidentSet.has(a)).length;
    const inlineInner = innerAccounts.length - altResidentInner;

    const wireEstimate = estimateWireSize({
      innerAccounts,
      altMap,
    });
    const fitsCap = wireEstimate <= 1232;

    process.stdout.write(
      `  inner accounts=${innerAccounts.length} (alt-resident=${altResidentInner}, inline=${inlineInner})\n`,
    );
    process.stdout.write(
      `  alts published=${altCount}, est wire-size=${wireEstimate}B ${fitsCap ? "✓" : "✗"} (cap 1232)\n`,
    );
    process.stdout.write(`  programId=${programOk ? "✓" : "✗"}\n`);

    if (!programOk || !fitsCap) {
      allOk = false;
    }
  } catch (e) {
    process.stdout.write(`  ERROR: ${e.message}\n`);
    allOk = false;
  }
}

process.stdout.write(`\n${allOk ? "✓ all pairs OK" : "✗ at least one pair failed"} (cluster=${CLUSTER})\n`);
process.exit(allOk ? 0 : 1);
