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
 * Cluster-aware policy emit. Devnet keeps the maximally-permissive
 * policy (any approver, sign_raw_payload activities) since iteration
 * speed matters more than blast-radius limits in dev. Mainnet adds
 * two additional gates:
 *
 *   1. `consensus` is pinned to a specific API user ID — only the
 *      designated keeper user can approve. Required env:
 *      `TURNKEY_KEEPER_USER_ID`. A leaked org-level key still can't
 *      sign because Turnkey requires the named user's X-Stamp.
 *
 *   2. The `condition` keeps activity-type gating. CEL on
 *      sign_raw_payload still can't reach into payload bytes, so
 *      ix-scoping continues to live in the keeper binary itself.
 *
 * Defense-in-depth that this script CAN'T emit (live in dashboard):
 *   - IP allowlist on the keeper API user (Turnkey UI under user
 *     settings; documented in MAINNET-UPGRADE-AUTHORITY.md).
 *   - Audit-log alerts on `ACTIVITY_TYPE_*` outside sign_raw_payload.
 */
const cluster = (process.env.CLUSTER ?? "devnet").toLowerCase();
const isMainnet = cluster === "mainnet" || cluster === "mainnet-beta";

const condition = "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'";

let consensus;
let policyName;
if (isMainnet) {
  const keeperUserId = process.env.TURNKEY_KEEPER_USER_ID;
  if (!keeperUserId || !keeperUserId.startsWith("u-")) {
    console.error(
      "✗ CLUSTER=mainnet requires TURNKEY_KEEPER_USER_ID (Turnkey API user id, format `u-xxxxxxxx`).",
    );
    console.error(
      "  Find it under Turnkey dashboard → Users → (your keeper API user) → User ID.",
    );
    process.exit(1);
  }
  // Escape any single-quotes in the id (defensive — Turnkey IDs are
  // base32-style and shouldn't contain quotes, but the script
  // shouldn't silently emit a broken policy if env is malformed).
  const safeId = keeperUserId.replace(/'/g, "");
  consensus = `approvers.any(user, user.id == '${safeId}')`;
  policyName = "sotama-keeper-mainnet-strict";
} else {
  // Devnet: any approver. The keeper API user's X-Stamp still
  // authenticates the request — this just doesn't add an extra
  // user-id pin on top.
  consensus = "approvers.any(user, true)";
  policyName = "sotama-keeper-execute-only";
}

const policy = {
  policyName,
  effect: "EFFECT_ALLOW",
  consensus,
  condition,
};

writeFileSync(outPath, JSON.stringify(policy, null, 2) + "\n");

console.log(`✓ wrote ${outPath}`);
console.log(`  cluster        : ${cluster}${isMainnet ? " (strict)" : " (permissive)"}`);
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
  "  so the policy constrains only activity type + (mainnet) approver user id.",
);
console.log(
  "  The Sotama-ix scoping is enforced by the keeper binary itself.",
);
console.log(
  "\nNext: paste the policy JSON into Turnkey's dashboard for the keeper API user.",
);
if (isMainnet) {
  console.log(
    `      Consensus pinned to user.id == '${process.env.TURNKEY_KEEPER_USER_ID}'.`,
  );
  console.log(
    "      Don't forget the IP allowlist (dashboard → Users → API user → Network).",
  );
  console.log(
    "      See MAINNET-UPGRADE-AUTHORITY.md for the full mainnet hardening checklist.",
  );
} else {
  console.log(
    "      Consensus is `approvers.any(user, true)` — no tag required.",
  );
  console.log(
    "      For mainnet: re-run with CLUSTER=mainnet TURNKEY_KEEPER_USER_ID=u-... to emit the strict policy.",
  );
}
