#!/usr/bin/env node
/**
 * Sanity-check that the P-256 keypair in keeper/.env actually matches —
 * derives the SEC1-uncompressed public key from `TURNKEY_API_PRIVATE_KEY`
 * and compares it against `TURNKEY_API_PUBLIC_KEY`. A mismatch means
 * Turnkey will 403 every X-Stamp because the signature can't be verified.
 *
 *     node scripts/verify-turnkey-keypair.mjs
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, createPublicKey } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = readFileSync(resolve(root, "keeper/.env"), "utf8");

function readEnv(key) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return "";
  let v = m[1].trim();
  // Strip dotenvy-style trailing inline comment ` # ...` so this script
  // sees the same value the Rust keeper sees after dotenvy parsing.
  const commentIdx = v.search(/\s+#/);
  if (commentIdx > -1) v = v.slice(0, commentIdx).trim();
  return v;
}

const priv = readEnv("TURNKEY_API_PRIVATE_KEY").replace(/^0x/, "");
const pub = readEnv("TURNKEY_API_PUBLIC_KEY").replace(/^0x/, "").toLowerCase();
const orgId = readEnv("TURNKEY_ORGANIZATION_ID");
const keyId = readEnv("TURNKEY_PRIVATE_KEY_ID");

if (priv.length !== 64) {
  console.error(`✗ TURNKEY_API_PRIVATE_KEY: ${priv.length} hex chars; expected 64 (raw P-256 scalar).`);
  console.error(`  If you pasted a PEM, extract the scalar with:`);
  console.error(`    openssl ec -in turnkey-api-key.pem -no_public -text 2>/dev/null \\`);
  console.error(`      | awk '/priv:/{f=1;next} f && /pub:/{exit} f{print}' \\`);
  console.error(`      | tr -d ' \\n:' | head -c 64`);
  process.exit(1);
}

// Turnkey shows public keys in compressed P-256 form by default
// (66 hex chars: `02xx...` or `03xx...`), but uncompressed (130 chars
// starting with `04`) is also accepted. The keeper's TurnkeySigner just
// passes whatever string it has into the X-Stamp's `publicKey` field, so
// either form works as long as Turnkey has the matching form registered
// for the API user.
const isCompressed =
  pub.length === 66 && (pub.startsWith("02") || pub.startsWith("03"));
const isUncompressed = pub.length === 130 && pub.startsWith("04");

if (!isCompressed && !isUncompressed) {
  console.error(
    `✗ TURNKEY_API_PUBLIC_KEY length/prefix unrecognized: ${pub.length} chars, prefix ${pub.slice(0, 4)}`,
  );
  console.error(
    `  expected: compressed (66 chars, 02/03 prefix) OR uncompressed (130 chars, 04 prefix)`,
  );
  process.exit(1);
}

// Derive expected public from private using node's crypto. P-256 = secp256r1 = prime256v1.
// We package the raw scalar into a JWK then ask node to spit out the public bytes.
const privBuf = Buffer.from(priv, "hex");
const jwk = {
  kty: "EC",
  crv: "P-256",
  d: privBuf.toString("base64url"),
  // Public coordinates required for jwkToKey but aren't used since we're going
  // priv → pub. Provide placeholders; node validates the curve point internally.
  // Workaround: import as PEM via openssl-derived ASN.1 instead of JWK.
};

// Cleaner path: build a SEC1 raw private key DER and import it.
// SEC1 ECPrivateKey ::= SEQUENCE {
//   version INTEGER (1),
//   privateKey OCTET STRING (32),
//   parameters [0] EXPLICIT NamedCurve OPTIONAL,
//   publicKey  [1] EXPLICIT BIT STRING OPTIONAL
// }
// We omit publicKey and let node derive it.
const namedCurveP256 = Buffer.from("06082a8648ce3d030107", "hex"); // OID 1.2.840.10045.3.1.7
const seq = (...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
};
const intOne = Buffer.from("020101", "hex");
const privOctet = Buffer.concat([Buffer.from([0x04, 0x20]), privBuf]);
const params = Buffer.concat([Buffer.from([0xa0, namedCurveP256.length]), namedCurveP256]);
const sec1 = seq(intOne, privOctet, params);

let derivedUncompressed;
let derivedCompressed;
try {
  const keyObj = createPrivateKey({ key: sec1, format: "der", type: "sec1" });
  const pubObj = createPublicKey(keyObj);
  const pubJwk = pubObj.export({ format: "jwk" });
  const x = Buffer.from(pubJwk.x, "base64url");
  const y = Buffer.from(pubJwk.y, "base64url");
  derivedUncompressed = "04" + x.toString("hex") + y.toString("hex");
  // Compressed = 02 if y is even, 03 if odd (last byte's LSB).
  const yIsOdd = (y[y.length - 1] & 1) === 1;
  derivedCompressed = (yIsOdd ? "03" : "02") + x.toString("hex");
} catch (e) {
  console.error(`✗ failed to derive public from private: ${e.message}`);
  console.error(`  this usually means the private hex isn't a valid P-256 scalar.`);
  process.exit(1);
}

const expected = isCompressed ? derivedCompressed : derivedUncompressed;

console.log(`org id        : ${orgId.length === 36 ? `${orgId.slice(0, 8)}…${orgId.slice(-4)}` : `(invalid: ${orgId.length} chars)`}`);
console.log(`priv key id   : ${keyId.length === 36 ? `${keyId.slice(0, 8)}…${keyId.slice(-4)}` : `(invalid: ${keyId.length} chars)`}`);
console.log(`env public    : ${pub.slice(0, 12)}…${pub.slice(-8)} (${isCompressed ? "compressed" : "uncompressed"})`);
console.log(`derived match : ${expected.slice(0, 12)}…${expected.slice(-8)}`);

if (pub === expected) {
  console.log(`\n✓ keypair matches — Turnkey can verify your X-Stamps.`);
  console.log(`  the 403 is a policy / consensus issue, not auth. Check:`);
  console.log(`    1. policy is ATTACHED to the API user (not just saved as a draft)`);
  console.log(`    2. the API user has the 'keeper' tag (or change consensus expr)`);
  console.log(`    3. TURNKEY_PRIVATE_KEY_ID matches a real Solana ed25519 key in this org`);
  process.exit(0);
} else {
  console.error(`\n✗ keypair MISMATCH — env public key doesn't match the one derived from your private key.`);
  console.error(`  every X-Stamp will fail signature verification → 403 from Turnkey.`);
  console.error(`  fix: re-paste the matching public key from the Turnkey dashboard, OR`);
  console.error(`       regenerate a fresh API key pair and update both env vars together.`);
  process.exit(1);
}
