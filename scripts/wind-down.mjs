#!/usr/bin/env node
/**
 * Wind-down orchestrator: admin-driven mass close of every active
 * Automation PDA after the kill switch has been pulled. Refunds user
 * deposits to their wallets/ATAs and routes all lamports (PDA rent +
 * any ATA rent) to `Config.treasury`.
 *
 * Pre-conditions (the script enforces these and aborts otherwise):
 *   1. `Config.shutdown == true`. Run `solana program invoke
 *      set_shutdown` first via the admin keypair (or a dedicated
 *      `set-shutdown.mjs` if added later). If shutdown is false, this
 *      script refuses to do anything.
 *   2. `Config.close_fee_lamports == 0`. The wind-down playbook calls
 *      for zeroing the fee BEFORE flipping shutdown so users who
 *      self-close during the grace window pay nothing. This script
 *      warns (does not abort) if the fee is non-zero — admin-driven
 *      close paths don't reference close_fee_lamports anyway, so it's
 *      advisory only.
 *
 * Usage:
 *     CLUSTER=devnet \
 *     ANCHOR_WALLET=keys/devnet-admin.json \
 *     node scripts/wind-down.mjs
 *
 *     # Mainnet
 *     CLUSTER=mainnet-beta \
 *     ANCHOR_WALLET=keys/mainnet-admin.json \
 *     node scripts/wind-down.mjs
 *
 * Squads multisig admin: this script signs and submits with a local
 * keypair. For a Squads-controlled admin, build the close ixs manually
 * via the Squads UI (custom-instruction → call admin_close_automation*
 * for each PDA). The list of PDAs to target is printed by this script
 * when it runs in --dry mode (`DRY=1`).
 *
 * Safety:
 *   - Serial submission (one tx confirmed before the next is sent) so
 *     a partial failure halts the run with a clean checkpoint.
 *   - Each close ix is its own tx. Batching multiple close-ixs into one
 *     tx is appealing but the per-tx account-count limit (256 keys)
 *     gets exhausted quickly with token rules; the additional tx-fees
 *     of one-per-tx are bounded (5_000 lamports each, paid by admin).
 *   - Retries are NOT automatic. If a tx fails (RPC blip, blockhash
 *     stale), the script prints the failure and stops. Re-running the
 *     script picks up where it left off (closed PDAs are gone from
 *     `getProgramAccounts`).
 */

import * as anchor from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import * as fs from "node:fs";
import * as path from "node:path";

const CLUSTER = (process.env.CLUSTER ?? "devnet").toLowerCase();
const DRY = process.env.DRY === "1";

const RPC_URL = (() => {
  switch (CLUSTER) {
    case "devnet":
      return process.env.RPC_URL ?? "https://api.devnet.solana.com";
    case "mainnet":
    case "mainnet-beta":
      return process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
    case "localnet":
      return process.env.RPC_URL ?? "http://localhost:8899";
    default:
      console.error(`✗ unrecognized CLUSTER=${CLUSTER}`);
      process.exit(1);
  }
})();

function loadAdminKeypair() {
  const walletPath = process.env.ANCHOR_WALLET ?? process.env.ADMIN_KEYPAIR;
  if (!walletPath) {
    console.error(
      "✗ ANCHOR_WALLET (or ADMIN_KEYPAIR) env required — path to admin keypair JSON.",
    );
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function loadProgram(admin) {
  const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const idlPath = path.join(rootDir, "target", "idl", "sotama_automations.json");
  if (!fs.existsSync(idlPath)) {
    console.error(`✗ IDL not found at ${idlPath} — run \`anchor build\` first.`);
    process.exit(1);
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));

  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);
  return { connection, program, provider };
}

async function main() {
  console.log(`Wind-down orchestrator — cluster=${CLUSTER}${DRY ? " (DRY)" : ""}`);
  console.log(`RPC: ${RPC_URL}`);

  const admin = loadAdminKeypair();
  const { connection, program, provider } = loadProgram(admin);

  console.log(`Admin: ${admin.publicKey.toBase58()}`);

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const config = await program.account.config.fetch(configPda);

  // ── Pre-flight ────────────────────────────────────────────────────
  console.log("");
  console.log("Pre-flight:");
  console.log(`  programId: ${program.programId.toBase58()}`);
  console.log(`  admin     : ${config.admin.toBase58()}`);
  console.log(`  treasury  : ${config.treasury.toBase58()}`);
  console.log(`  paused    : ${config.paused}`);
  console.log(`  shutdown  : ${config.shutdown}`);
  console.log(`  closeFee  : ${config.closeFeeLamports.toString()} lamports`);
  console.log("");

  if (admin.publicKey.toBase58() !== config.admin.toBase58()) {
    console.error("✗ Loaded keypair is not the program admin. Aborting.");
    process.exit(1);
  }
  if (!config.shutdown) {
    console.error("✗ Config.shutdown is false. Run set_shutdown first via the admin keypair.");
    console.error("  Wind-down refuses to operate when shutdown is not active.");
    process.exit(1);
  }
  if (config.closeFeeLamports.toString() !== "0") {
    console.warn("⚠  closeFeeLamports is non-zero. Admin-close paths don't honor it,");
    console.warn("   but users who self-closed during the grace window may have paid the fee.");
  }

  // ── Enumerate active automations ──────────────────────────────────
  const all = await program.account.automation.all();
  const targets = all.filter((a) => !a.account.finished);
  console.log(`Found ${targets.length} active automation PDAs (skipping ${all.length - targets.length} finished).`);
  if (targets.length === 0) {
    console.log("Nothing to wind down. You can now run `solana program close <PROGRAM_ID>` to reclaim program rent.");
    return;
  }

  // ── Group by action kind ──────────────────────────────────────────
  const buckets = { sol: [], spl: [], swap: [], stake: [] };
  for (const a of targets) {
    const action = a.account.action;
    if (action.transferSol) buckets.sol.push(a);
    else if (action.transferSpl) buckets.spl.push(a);
    else if (action.swap) buckets.swap.push(a);
    else if (action.stakeRestake || action.stakeWithdrawReward) buckets.stake.push(a);
    else {
      console.warn(`⚠  ${a.publicKey.toBase58()} has unrecognized action shape; skipping.`);
    }
  }
  console.log(
    `  SOL action  : ${buckets.sol.length}\n  Stake action: ${buckets.stake.length}\n  SPL action  : ${buckets.spl.length}\n  Swap action : ${buckets.swap.length}`,
  );

  if (DRY) {
    console.log("\n--- DRY mode: listing target PDAs ---");
    for (const [kind, items] of Object.entries(buckets)) {
      for (const a of items) {
        console.log(`  ${kind.padEnd(6)} ${a.publicKey.toBase58()}  owner=${a.account.owner.toBase58()}`);
      }
    }
    console.log("\nRe-run without DRY=1 to execute the unwind.");
    return;
  }

  // ── Execute closes ────────────────────────────────────────────────
  let closed = 0;
  let failed = 0;

  // SOL + stake share the same admin_close_automation ix.
  for (const a of [...buckets.sol, ...buckets.stake]) {
    const sig = await closeOne(connection, program, provider, admin, configPda, config.treasury, a, "sol_or_stake");
    if (sig) closed++;
    else {
      failed++;
      console.error(`  ✗ failed; re-run the script after diagnosing.`);
      break;
    }
  }
  for (const a of buckets.spl) {
    const sig = await closeOne(connection, program, provider, admin, configPda, config.treasury, a, "spl");
    if (sig) closed++;
    else {
      failed++;
      break;
    }
  }
  for (const a of buckets.swap) {
    const sig = await closeOne(connection, program, provider, admin, configPda, config.treasury, a, "swap");
    if (sig) closed++;
    else {
      failed++;
      break;
    }
  }

  console.log("");
  console.log(`Closed: ${closed} / ${targets.length}`);
  if (failed > 0) {
    console.log(`Failed: ${failed} (run the script again to retry).`);
    process.exit(1);
  } else {
    console.log("All active PDAs closed. Next step:");
    console.log(`  solana program close ${program.programId.toBase58()} --url ${RPC_URL} --bypass-warning --recipient ${config.treasury.toBase58()}`);
    console.log("  (the upgrade-authority wallet must sign — see MAINNET-UPGRADE-AUTHORITY.md)");
  }
}

async function closeOne(connection, program, provider, admin, configPda, treasury, a, kind) {
  const ownerPk = a.account.owner;
  const automationPk = a.publicKey;
  console.log(`→ ${kind.padEnd(15)} ${automationPk.toBase58()}  owner=${ownerPk.toBase58()}`);
  try {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));

    if (kind === "spl") {
      const mint = a.account.action.transferSpl.mint;
      const ownerAta = getAssociatedTokenAddressSync(mint, ownerPk);
      const autoAta = getAssociatedTokenAddressSync(mint, automationPk, true);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          ownerAta,
          ownerPk,
          mint,
        ),
      );
      const ix = await program.methods
        .adminCloseAutomationSpl()
        .accountsStrict({
          admin: admin.publicKey,
          owner: ownerPk,
          automation: automationPk,
          config: configPda,
          treasury,
          mint,
          ownerAta,
          automationAta: autoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      tx.add(ix);
    } else if (kind === "swap") {
      const inputMint = a.account.action.swap.inputMint;
      const ownerAta = getAssociatedTokenAddressSync(inputMint, ownerPk);
      const autoAta = getAssociatedTokenAddressSync(inputMint, automationPk, true);
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          admin.publicKey,
          ownerAta,
          ownerPk,
          inputMint,
        ),
      );
      const ix = await program.methods
        .adminCloseAutomationSwap()
        .accountsStrict({
          admin: admin.publicKey,
          owner: ownerPk,
          automation: automationPk,
          config: configPda,
          treasury,
          inputMint,
          ownerInputAta: ownerAta,
          automationInputAta: autoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .instruction();
      tx.add(ix);
    } else {
      const ix = await program.methods
        .adminCloseAutomation()
        .accountsStrict({
          admin: admin.publicKey,
          owner: ownerPk,
          automation: automationPk,
          config: configPda,
          treasury,
        })
        .instruction();
      tx.add(ix);
    }

    tx.feePayer = admin.publicKey;
    const sig = await provider.sendAndConfirm(tx, [admin], { commitment: "confirmed" });
    console.log(`   ✓ ${sig}`);
    return sig;
  } catch (e) {
    console.error(`   ✗ ${e?.message ?? e}`);
    return null;
  }
}

// Suppress unused-warning for the explicit ATA program import.
void ASSOCIATED_TOKEN_PROGRAM_ID;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
