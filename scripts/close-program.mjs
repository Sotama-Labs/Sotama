#!/usr/bin/env node
/**
 * Print (do NOT execute) the `solana program close` command needed to
 * close the Sotama program for rent reclaim.
 *
 * This script never invokes a destructive operation. It runs read-only
 * checks (`solana program show`, balance lookups) and emits the exact
 * command the operator should paste into their shell after reviewing
 * the output. Closing a program is irreversible — the program ID is
 * permanently retired, all on-chain users locked out — so a "press
 * enter to confirm" UX is too lenient for the actual close call.
 *
 * Usage:
 *     CLUSTER=devnet PROGRAM_ID=<base58> node scripts/close-program.mjs
 *     CLUSTER=mainnet PROGRAM_ID=<base58> RECIPIENT=<wallet> \
 *         node scripts/close-program.mjs
 *
 * Env:
 *     CLUSTER       devnet | mainnet | localnet (default: devnet)
 *     PROGRAM_ID    base58 program pubkey to close
 *     RECIPIENT     base58 wallet receiving the rent refund
 *                   (defaults to the active solana-cli config wallet)
 *
 * Pre-checks (read-only, run automatically):
 *     1. `solana --version` — confirms CLI is on PATH.
 *     2. `solana program show <PROGRAM_ID>` — prints upgrade authority,
 *        data length, and current balance so the operator sees the
 *        rent they'll get back.
 *     3. Lists any close-eligible buffers
 *        (`solana program show --buffers`) — those carry separate rent
 *        and have their own close path.
 *
 * After running, paste the printed command into your shell. The
 * authority's keypair (file or hardware wallet) must be unlocked.
 *
 * Squads multisig: the printed command targets the CLI; for a Squads
 * multisig authority, use the Squads UI to construct the equivalent
 * BPFLoaderUpgradeable::Close transaction. The runbook in
 * MAINNET-UPGRADE-AUTHORITY.md covers the multisig path.
 */

import { execFileSync, spawnSync } from "node:child_process";

const cluster = (process.env.CLUSTER ?? "devnet").toLowerCase();
const programId = process.env.PROGRAM_ID;
const recipient = process.env.RECIPIENT; // optional

if (!programId) {
  console.error(
    "✗ PROGRAM_ID env required (base58 program pubkey to close).",
  );
  console.error(
    "  Example: PROGRAM_ID=2gp9bMBEVpQp6Lyyg13Bw6XF9S9saAcm9C4XQ69T8ZqQ \\",
  );
  console.error(
    "           CLUSTER=devnet node scripts/close-program.mjs",
  );
  process.exit(1);
}

const clusterUrl = (() => {
  switch (cluster) {
    case "devnet":
      return "https://api.devnet.solana.com";
    case "mainnet":
    case "mainnet-beta":
      return "https://api.mainnet-beta.solana.com";
    case "localnet":
      return "http://localhost:8899";
    default:
      console.error(`✗ unrecognized CLUSTER=${cluster}`);
      process.exit(1);
  }
})();

console.log(`Closing program — pre-flight checks (cluster=${cluster}):`);
console.log("");

// ── 1. solana --version ───────────────────────────────────────────────
try {
  const version = execFileSync("solana", ["--version"], {
    encoding: "utf8",
  }).trim();
  console.log(`✓ ${version}`);
} catch {
  console.error("✗ `solana` CLI not found on PATH. Install it first.");
  process.exit(1);
}

// ── 2. solana program show ────────────────────────────────────────────
console.log("");
console.log(`→ solana program show ${programId} --url ${clusterUrl}`);
const show = spawnSync(
  "solana",
  ["program", "show", programId, "--url", clusterUrl],
  { encoding: "utf8" },
);
if (show.status !== 0) {
  console.error(show.stderr || show.stdout || "program show failed");
  console.error(
    "  hint: confirm PROGRAM_ID is correct and the cluster is reachable.",
  );
  process.exit(1);
}
console.log(show.stdout);

// ── 3. solana program show --buffers ──────────────────────────────────
console.log(
  `→ solana program show --buffers --url ${clusterUrl} (rent in failed-deploy buffers)`,
);
const buffers = spawnSync(
  "solana",
  ["program", "show", "--buffers", "--url", clusterUrl],
  { encoding: "utf8" },
);
if (buffers.status === 0) {
  const out = buffers.stdout.trim();
  if (out && out !== "" && !out.toLowerCase().startsWith("buffer address")) {
    console.log(out);
  } else if (out) {
    console.log(out);
  } else {
    console.log("  (no close-eligible buffers under the current authority)");
  }
} else {
  console.log(
    `  (skipped — ${buffers.stderr?.trim() || "show --buffers errored"})`,
  );
}
console.log("");

// ── Emit the actual close command ─────────────────────────────────────
const closeCmd = [
  "solana",
  "program",
  "close",
  programId,
  recipient ? `--recipient ${recipient}` : null,
  `--url ${clusterUrl}`,
  "--bypass-warning",
]
  .filter(Boolean)
  .join(" ");

console.log("─".repeat(72));
console.log("Review the above. To close the program (IRREVERSIBLE), run:");
console.log("");
console.log(`    ${closeCmd}`);
console.log("");
if (!recipient) {
  console.log(
    "  Without RECIPIENT set, the active `solana config get` wallet receives the refund.",
  );
}
console.log(
  "  Once closed, the program ID is permanently retired — it cannot be re-deployed.",
);
console.log(
  "  For a Squads-multisig upgrade authority, queue the equivalent ix via the Squads UI",
);
console.log(
  "  rather than running this command (the CLI requires a single-key authority).",
);
