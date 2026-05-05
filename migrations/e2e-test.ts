/* ─────────────────────────────────────────────────────────────────────
   End-to-end smoke test — exercises the full keeper pipeline without
   the UI.
     1. Generates a fresh "watched" wallet + a fresh "destination" wallet.
     2. Funds the watched wallet with a tiny amount of SOL.
     3. Calls create_automation: watched watches all txs, action is
        transfer 0.05 SOL → destination.
     4. From the watched wallet, sends an arbitrary tx (a self-transfer).
     5. Polls the destination balance until the keeper executes (or times
        out).
   Run with `pnpm anchor:e2e:devnet` after `anchor:initialize:devnet`,
   while the keeper is running in another terminal.
   ───────────────────────────────────────────────────────────────────── */

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import type { SotamaAutomations } from "../target/types/sotama_automations";

const AMOUNT_SOL = 0.05;
const FUND_WATCHED_SOL = 0.02;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .sotamaAutomations as anchor.Program<SotamaAutomations>;
  const conn = provider.connection;
  const owner = (provider.wallet as anchor.Wallet).payer;

  const watched = Keypair.generate();
  const destination = Keypair.generate();

  console.log("watched     :", watched.publicKey.toBase58());
  console.log("destination :", destination.publicKey.toBase58());
  console.log("owner       :", owner.publicKey.toBase58());

  // ── 1. Fund the watched wallet so it can pay tx fees.
  console.log(`\nFunding watched with ${FUND_WATCHED_SOL} SOL...`);
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: watched.publicKey,
        lamports: Math.round(FUND_WATCHED_SOL * LAMPORTS_PER_SOL),
      })
    );
    const sig = await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
    console.log("  fund sig :", sig);
  }

  // ── 2. Create an automation.
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );
  const cfg = await program.account.config.fetch(configPda);
  const nonce = BigInt(cfg.automationCount.toString());
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  const [automationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("automation"), owner.publicKey.toBuffer(), nonceBuf],
    program.programId
  );

  const amountLamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);
  console.log(`\nCreating automation #${nonce} (deposit ${AMOUNT_SOL} SOL)...`);
  console.log("  PDA      :", automationPda.toBase58());
  const createSig = await program.methods
    .createAutomation(watched.publicKey, destination.publicKey, new BN(amountLamports))
    .accountsStrict({
      owner: owner.publicKey,
      config: configPda,
      automation: automationPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("  tx       :", createSig);

  // Small delay — devnet RPCs occasionally lag write→read consistency.
  await sleep(2_000);
  const a = await program.account.automation.fetch(automationPda);
  console.log("  watched  :", a.watchedAccount.toBase58());
  console.log("  dest     :", a.destination.toBase58());
  console.log("  amount   :", a.amountLamports.toString(), "lamports");
  console.log("  executed :", a.executed);

  // ── 3. Wait briefly so the keeper's indexer picks up the new automation.
  console.log("\nWaiting 18s for keeper indexer reconcile (interval=15s)...");
  await sleep(18_000);

  // ── 4. Trigger: send any tx from the watched wallet. We do a tiny
  // self-transfer of 1 lamport.
  console.log("\nFiring trigger — sending self-transfer from watched...");
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: watched.publicKey,
        toPubkey: watched.publicKey,
        lamports: 1,
      })
    );
    const sig = await anchor.web3.sendAndConfirmTransaction(conn, tx, [watched], {
      commitment: "confirmed",
    });
    console.log("  trigger sig :", sig);
  }

  // ── 5. Poll destination balance until the keeper fires.
  console.log("\nPolling destination balance (timeout 90s)...");
  const start = Date.now();
  let prev = 0;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const bal = await conn.getBalance(destination.publicKey);
    if (bal !== prev) {
      console.log(`  balance = ${bal / LAMPORTS_PER_SOL} SOL`);
      prev = bal;
    }
    if (bal >= amountLamports) {
      console.log("\n✅ keeper fired execute_automation");
      const after = await program.account.automation.fetch(automationPda);
      console.log("  executed    :", after.executed);
      console.log("  executed_at :", after.executedAt.toString());
      process.exit(0);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log("\n❌ timed out — keeper did not execute within 90s");
  console.log("  check keeper logs for errors");
  process.exit(1);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error("e2e failed:", e);
  process.exit(1);
});
