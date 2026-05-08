#!/usr/bin/env node
/**
 * One-shot: rotate the on-chain `Config.keeper` to a new pubkey via the
 * `update_keeper` ix. Useful when the keeper key changes (e.g. switching
 * from a local keypair to a Turnkey-stored ed25519 key, or rotating
 * Turnkey keys before mainnet).
 *
 *     node scripts/rotate-devnet-keeper.mjs <NEW_KEEPER_PUBKEY> [--cluster devnet]
 *
 * Reads the admin keypair from ~/.config/solana/id.json (must match
 * `Config.admin` on-chain — only the admin can rotate the keeper).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  AnchorProvider,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const args = process.argv.slice(2);
const newKeeperStr = args[0];
const cluster =
  args.includes("--cluster")
    ? args[args.indexOf("--cluster") + 1]
    : "devnet";

if (!newKeeperStr) {
  console.error("usage: rotate-devnet-keeper.mjs <NEW_KEEPER_PUBKEY> [--cluster devnet|mainnet-beta]");
  process.exit(1);
}

const newKeeper = new PublicKey(newKeeperStr);

const idlPath = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..", "target", "idl", "sotama_automations.json");
const idl = JSON.parse(readFileSync(idlPath, "utf8"));

const rpc =
  cluster === "mainnet-beta"
    ? "https://api.mainnet-beta.solana.com"
    : "https://api.devnet.solana.com";

const connection = new Connection(rpc, "confirmed");

const adminPath = resolve(homedir(), ".config", "solana", "id.json");
const adminKp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(adminPath, "utf8"))),
);

const wallet = new Wallet(adminKp);
const provider = new AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const program = new Program(idl, provider);

const programId = program.programId;
const [configPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("config")],
  programId,
);

const before = await program.account.config.fetch(configPda);
console.log(`cluster:       ${cluster}`);
console.log(`program:       ${programId.toBase58()}`);
console.log(`admin:         ${before.admin.toBase58()}`);
console.log(`keeper before: ${before.keeper.toBase58()}`);
console.log(`keeper after:  ${newKeeper.toBase58()}`);

if (!before.admin.equals(adminKp.publicKey)) {
  console.error(
    `\n✗ ~/.config/solana/id.json (${adminKp.publicKey.toBase58()}) does not match Config.admin (${before.admin.toBase58()}). Aborting.`,
  );
  process.exit(1);
}

if (before.keeper.equals(newKeeper)) {
  console.log("\n✓ keeper already at the requested pubkey; nothing to do.");
  process.exit(0);
}

const sig = await program.methods
  .updateKeeper(newKeeper)
  .accountsStrict({
    admin: adminKp.publicKey,
    config: configPda,
  })
  .rpc();
console.log(`\n✓ rotated. tx: ${sig}`);

const after = await program.account.config.fetch(configPda);
console.log(`keeper now:    ${after.keeper.toBase58()}`);
