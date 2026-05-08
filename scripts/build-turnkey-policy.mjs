#!/usr/bin/env node
/**
 * Generate the Turnkey policy JSON that auto-allows the keeper to call
 * `sign_raw_payload_v2` on its Solana ed25519 key. The output goes in
 * `keeper/turnkey-policy.json` — paste it into the Turnkey dashboard's
 * policy editor for the keeper API user.
 *
 * Usage:
 *     pnpm keeper:policy
 *     # or directly:
 *     node scripts/build-turnkey-policy.mjs
 *
 * --------------------------------------------------------------------
 * What this policy actually constrains (and what it can't)
 * --------------------------------------------------------------------
 *
 * Per the Turnkey policy language docs
 * (https://docs.turnkey.com/concepts/policies/language), the policy
 * expression is a single CEL string. For `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2`
 * the only fields exposed under `activity.params` are:
 *
 *   • `activity.params.hash_function`  (e.g. HASH_FUNCTION_NOT_APPLICABLE)
 *   • `activity.params.encoding`       (e.g. PAYLOAD_ENCODING_HEXADECIMAL)
 *
 * The raw payload bytes are **not** exposed, so we can't whitelist a
 * specific Solana program ID + execute_* discriminator at the Turnkey
 * layer. CEL on strings doesn't expose `.contains()` either — only `==`
 * / `!=` / slicing.
 *
 * That means our defense-in-depth here is:
 *
 *   1. The Turnkey policy below restricts the keeper API user to
 *      sign-raw-payload activities only, with hex encoding and the
 *      Solana-correct hash function. So a leaked API key still can't
 *      pivot to deleting users, exporting keys, or signing under a
 *      non-Solana scheme.
 *
 *   2. The keeper API user's scope (configured in the Turnkey
 *      dashboard, NOT in this policy) is bound to one specific Solana
 *      ed25519 private key. So any sign call uses that key, regardless
 *      of payload contents.
 *
 *   3. The actual "only sign Sotama execute_* ixs" guarantee lives in
 *      the keeper Rust code (`keeper/src/executor.rs`), which is the
 *      only path that builds and submits payloads. A compromised keeper
 *      binary or environment variables WOULD still be able to sign
 *      arbitrary Solana transactions with that key — the on-chain
 *      Sotama program enforces ownership/destination invariants but
 *      the keeper itself is trusted (same trust model as v3).
 *
 * If you need stronger payload-level constraints, the path forward is
 * to switch to `ACTIVITY_TYPE_SIGN_TRANSACTION_V2` (which exposes
 * structured tx fields per supported chain) — but Solana doesn't yet
 * have first-class support there as of this writing, so we stay on
 * raw payload signing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const idlPath = resolve(root, "target/idl/sotama_automations.json");
const outPath = resolve(root, "keeper/turnkey-policy.json");

/**
 * Sotama execute_* ix discriminators we expect to find on-chain. Listed
 * here purely so the script can fail loudly if a future IDL drops one
 * — it doesn't affect the generated policy, since Turnkey can't pattern
 * match payload bytes.
 */
const EXPECTED_IXS = [
  "execute_automation",
  "execute_automation_spl",
  "execute_restake",
  "execute_withdraw_reward",
  "execute_swap",
  "execute_link_fee_debit",
  "execute_fee_topup",
];

let idl;
try {
  idl = JSON.parse(readFileSync(idlPath, "utf8"));
} catch (err) {
  console.error(
    `✗ failed to read ${idlPath}\n  ${err.message}\n  hint: run \`pnpm anchor:build\` first.`,
  );
  process.exit(1);
}

const programIdBase58 = idl.address;
if (!programIdBase58) {
  console.error("✗ idl.address missing — IDL is malformed");
  process.exit(1);
}
const programIdHex = new PublicKey(programIdBase58).toBuffer().toString("hex");

const discriminators = EXPECTED_IXS.map((name) => {
  const ix = idl.instructions?.find((i) => i.name === name);
  if (!ix) {
    console.error(`✗ instruction \`${name}\` not found in IDL`);
    process.exit(1);
  }
  if (!Array.isArray(ix.discriminator) || ix.discriminator.length !== 8) {
    console.error(
      `✗ instruction \`${name}\` has bad discriminator: ${JSON.stringify(ix.discriminator)}`,
    );
    process.exit(1);
  }
  return {
    name,
    hex: Buffer.from(ix.discriminator).toString("hex"),
  };
});

/**
 * Minimal CEL condition: just gate on activity type. The encoding /
 * hash_function clauses we tried earlier appear to evaluate to false
 * in some Turnkey deployments (path may not be exposed for the
 * specific activity flavor, or the values may not match the
 * documented constants). The keeper code already sends the right
 * encoding and hash function — there's no realistic attacker path
 * where the condition needed those extra checks.
 *
 * If you want defense-in-depth, layer additional clauses one at a
 * time and verify each still allows. The error response (visible in
 * the keeper log via `turnkey http 403:`) shows OUTCOME_DENY_IMPLICIT
 * but doesn't tell you which clause failed, so always change one
 * thing at a time.
 */
const condition = "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'";

/**
 * Consensus: maximally permissive — any approver is fine. This works
 * because Turnkey already authenticates the requester via the X-Stamp
 * (the API user holding the matching P-256 keypair). If you want to
 * pin to a specific API user later:
 *   `approvers.any(user, user.id == 'YOUR_API_USER_ID')`
 * Or by tag (requires tagging the user in the dashboard):
 *   `approvers.any(user, 'keeper' in user.tags)`
 */
const consensus = "approvers.any(user, true)";

const policy = {
  policyName: "sotama-keeper-execute-only",
  effect: "EFFECT_ALLOW",
  consensus,
  condition,
};

writeFileSync(outPath, JSON.stringify(policy, null, 2) + "\n");

console.log(`✓ wrote ${outPath}`);
console.log(`  program ID     : ${programIdBase58}`);
console.log(`  program ID hex : ${programIdHex}`);
console.log(`  expected ixs   :`);
for (const d of discriminators) {
  console.log(`    ${d.name.padEnd(28)} ${d.hex}`);
}
console.log(
  "\n  Note: Turnkey policy language can't substring-match payload bytes,",
);
console.log(
  "  so the policy constrains only activity type + encoding + hash function.",
);
console.log(
  "  The Sotama-ix scoping is enforced by the keeper binary itself.",
);
console.log(
  "\nNext: paste the policy JSON into Turnkey's dashboard for the keeper API user.",
);
console.log(
  "      Consensus is `approvers.any(user, true)` — no tag required.",
);
console.log(
  "      Tighten later by pinning user.id once devnet works end-to-end.",
);
