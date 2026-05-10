/* ─────────────────────────────────────────────────────────────────────
   One-shot migration: rotate Config.keeper to a new pubkey. Used when
   the keeper signing identity changes (e.g. local keypair → Turnkey).

   Run with the same env shape as initialize.ts:
     ANCHOR_PROVIDER_URL=… ANCHOR_WALLET=$HOME/.config/solana/id.json \
       ts-node migrations/rotate-keeper.ts <NEW_KEEPER_PUBKEY>

   The admin (provider wallet) signs the update_keeper ix.
   ───────────────────────────────────────────────────────────────────── */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import type { SotamaAutomations } from "../target/types/sotama_automations";

async function main() {
  const newKeeperArg = process.argv[2];
  if (!newKeeperArg) {
    console.error("usage: rotate-keeper.ts <NEW_KEEPER_PUBKEY>");
    process.exit(1);
  }
  const newKeeper = new PublicKey(newKeeperArg);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .sotamaAutomations as anchor.Program<SotamaAutomations>;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const admin = (provider.wallet as anchor.Wallet).publicKey;

  console.log("program ID :", program.programId.toBase58());
  console.log("admin      :", admin.toBase58());
  console.log("config PDA :", configPda.toBase58());
  console.log("new keeper :", newKeeper.toBase58());

  const before = await program.account.config.fetch(configPda);
  console.log("old keeper :", before.keeper.toBase58());
  if (before.keeper.equals(newKeeper)) {
    console.log("\nConfig.keeper already matches; nothing to do.");
    process.exit(0);
  }

  const sig = await program.methods
    .updateKeeper(newKeeper)
    .accountsStrict({
      admin,
      config: configPda,
    })
    .rpc();

  console.log("\nrotated:", sig);
}

main().catch((e) => {
  console.error("rotate failed:", e);
  process.exit(1);
});
