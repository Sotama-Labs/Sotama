/* ─────────────────────────────────────────────────────────────────────
   One-shot migration: initialize Config singleton on the deployed
   sotama_automations program. Run with `pnpm anchor:initialize:devnet`
   after `pnpm anchor:deploy:devnet`.

   Assumes:
   - Anchor.toml [provider] points at the cluster you want
   - The provider's wallet is the program admin
   - keeper/keeper-keypair.json holds the keeper signing keypair
   ───────────────────────────────────────────────────────────────────── */

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SotamaAutomations } from "../target/types/sotama_automations";

const KEEPER_KEYPAIR_PATH = path.resolve("keeper/keeper-keypair.json");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .sotamaAutomations as anchor.Program<SotamaAutomations>;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const keeperRaw = JSON.parse(fs.readFileSync(KEEPER_KEYPAIR_PATH, "utf8"));
  const keeperKp = Keypair.fromSecretKey(Uint8Array.from(keeperRaw));
  const keeperPk = keeperKp.publicKey;

  const admin = (provider.wallet as anchor.Wallet).publicKey;

  console.log("program ID :", program.programId.toBase58());
  console.log("admin      :", admin.toBase58());
  console.log("keeper     :", keeperPk.toBase58());
  console.log("config PDA :", configPda.toBase58());

  const existing = await program.account.config.fetchNullable(configPda);
  if (existing) {
    console.log("\nConfig already initialized:");
    console.log("  admin            :", existing.admin.toBase58());
    console.log("  keeper           :", existing.keeper.toBase58());
    console.log("  paused           :", existing.paused);
    console.log("  automation_count :", existing.automationCount.toString());
    process.exit(0);
  }

  const sig = await program.methods
    .initializeConfig(keeperPk)
    .accountsStrict({
      admin,
      config: configPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log("\ninitialized:", sig);
}

main().catch((e) => {
  console.error("initialize failed:", e);
  process.exit(1);
});
