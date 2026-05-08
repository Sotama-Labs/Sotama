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
const CLUSTER = process.env.CLUSTER ?? "devnet";
const MAX_ACCOUNTS = 25;
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
  const r = await fetch(url);
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

for (const p of PAIRS) {
  process.stdout.write(`\n[${p.label}] amount=${fmtNum(p.amount)}\n`);

  try {
    const quoteUrl = `${BASE_URL}/swap/v1/quote?inputMint=${p.input}&outputMint=${p.output}&amount=${p.amount}&slippageBps=50&onlyDirectRoutes=false`;
    const quote = await fetchJson(quoteUrl);
    process.stdout.write(`  quote: in=${fmtNum(quote.inAmount)}, out=${fmtNum(quote.outAmount)}, hops=${quote.routePlan?.length ?? "?"}\n`);

    // Mirror the keeper's `build_swap_cpi_safe` logic: try multi-hop
    // first, fall back to onlyDirectRoutes if it exceeds the budget.
    const buildUrl = `${BASE_URL}/swap/v2/build?inputMint=${p.input}&outputMint=${p.output}&amount=${p.amount}&slippageBps=50&taker=${TAKER}&maxAccounts=${MAX_ACCOUNTS}`;
    const multi = await fetchJson(buildUrl);
    const multiCount = multi.swapInstruction?.accounts?.length ?? 0;
    const programId = multi.swapInstruction?.programId;
    const programOk = programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

    let used;
    if (multiCount <= MAX_ACCOUNTS) {
      used = { route: "multi-hop", count: multiCount };
    } else {
      const directUrl = `${buildUrl}&onlyDirectRoutes=true`;
      const direct = await fetchJson(directUrl);
      const directCount = direct.swapInstruction?.accounts?.length ?? 0;
      used = { route: "direct-only fallback", count: directCount };
      process.stdout.write(`  multi-hop: ${multiCount} accts (over cap)\n`);
    }
    const accountsOk = used.count <= MAX_ACCOUNTS;

    process.stdout.write(
      `  build: programId=${programOk ? "✓" : "✗"}, route=${used.route}, accounts=${used.count} ${accountsOk ? "✓" : "✗"} (cap ${MAX_ACCOUNTS})\n`,
    );

    if (!programOk || !accountsOk) {
      allOk = false;
    }
  } catch (e) {
    process.stdout.write(`  ERROR: ${e.message}\n`);
    allOk = false;
  }
}

process.stdout.write(`\n${allOk ? "✓ all pairs OK" : "✗ at least one pair failed"} (cluster=${CLUSTER})\n`);
process.exit(allOk ? 0 : 1);
