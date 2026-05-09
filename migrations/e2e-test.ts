/* ─────────────────────────────────────────────────────────────────────
   End-to-end smoke test (v2) — exercises the keeper pipeline on devnet
   without the UI. Defaults to the AccountActivity → TransferSol path,
   which is the simplest end-to-end variant. Pass `--variant=spl` or
   `--variant=token-price` to test the new v2 paths.

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
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import type { SotamaAutomations } from "../target/types/sotama_automations";

const AMOUNT_SOL = 0.05;
const FUND_WATCHED_SOL = 0.02;
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 90_000;

type Variant = "sol" | "spl" | "token-price";

function variantArg(): Variant {
  const arg = process.argv.find((a) => a.startsWith("--variant="));
  if (!arg) return "sol";
  const value = arg.split("=")[1];
  if (value === "spl" || value === "token-price") return value;
  return "sol";
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .sotamaAutomations as anchor.Program<SotamaAutomations>;
  const conn = provider.connection;
  const owner = (provider.wallet as anchor.Wallet).payer;
  const variant = variantArg();

  console.log("variant     :", variant);
  console.log("owner       :", owner.publicKey.toBase58());

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  switch (variant) {
    case "sol":
      await runSolVariant(provider, program, conn, owner, configPda);
      break;
    case "spl":
      await runSplVariant(provider, program, conn, owner, configPda);
      break;
    case "token-price":
      await runAssetPriceVariant(provider, program, conn, owner, configPda);
      break;
  }
}

async function runSolVariant(
  provider: anchor.AnchorProvider,
  program: anchor.Program<SotamaAutomations>,
  conn: anchor.web3.Connection,
  owner: Keypair,
  configPda: PublicKey
) {
  const watched = Keypair.generate();
  const destination = Keypair.generate();
  console.log("watched     :", watched.publicKey.toBase58());
  console.log("destination :", destination.publicKey.toBase58());

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
    .createAutomation(
      { accountActivity: { account: watched.publicKey, mint: null, kind: 0 } } as never,
      { transferSol: { destination: destination.publicKey, amount: new BN(amountLamports) } } as never
    )
    .accountsStrict({
      owner: owner.publicKey,
      config: configPda,
      automation: automationPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("  tx       :", createSig);

  await sleep(2_000);
  const a = await program.account.automation.fetch(automationPda);
  console.log("  trigger  :", a.trigger);
  console.log("  action   :", a.action);
  console.log("  executed :", a.executed);

  console.log("\nWaiting 18s for keeper indexer reconcile (interval=15s)...");
  await sleep(18_000);

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

async function runSplVariant(
  provider: anchor.AnchorProvider,
  program: anchor.Program<SotamaAutomations>,
  conn: anchor.web3.Connection,
  owner: Keypair,
  configPda: PublicKey
) {
  const watched = Keypair.generate();
  const splDestination = Keypair.generate();
  console.log("watched     :", watched.publicKey.toBase58());
  console.log("destination :", splDestination.publicKey.toBase58());

  // Mint a fresh test token and pre-fund the watched wallet for trigger fires.
  const mint = Keypair.generate();
  const mintRent = await getMinimumBalanceForRentExemptMint(conn);
  const decimals = 6;
  const ownerAta = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey);
  const destAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    splDestination.publicKey
  );

  console.log(`\nMinting test token...`);
  {
    const tx = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: mintRent,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        })
      )
      .add(
        createInitializeMintInstruction(mint.publicKey, decimals, owner.publicKey, null)
      )
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          owner.publicKey,
          ownerAta,
          owner.publicKey,
          mint.publicKey
        )
      )
      .add(
        createMintToInstruction(
          mint.publicKey,
          ownerAta,
          owner.publicKey,
          5_000_000n
        )
      );
    const sig = await anchor.web3.sendAndConfirmTransaction(
      conn,
      tx,
      [owner, mint],
      { commitment: "confirmed" }
    );
    console.log("  mint sig :", sig);
  }

  // Fund watched so it can trigger.
  console.log(`Funding watched with ${FUND_WATCHED_SOL} SOL...`);
  await provider.sendAndConfirm(
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: watched.publicKey,
        lamports: Math.round(FUND_WATCHED_SOL * LAMPORTS_PER_SOL),
      })
    ),
    [],
    { commitment: "confirmed" }
  );

  const cfg = await program.account.config.fetch(configPda);
  const nonce = BigInt(cfg.automationCount.toString());
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  const [automationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("automation"), owner.publicKey.toBuffer(), nonceBuf],
    program.programId
  );
  const automationAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    automationPda,
    true
  );
  const splAmount = 1_000_000;

  console.log(`\nCreating SPL automation #${nonce}...`);
  console.log("  PDA      :", automationPda.toBase58());

  const createIx = await program.methods
    .createAutomationSpl(
      { accountActivity: { account: watched.publicKey, mint: null, kind: 0 } } as never,
      {
        transferSpl: {
          destination: splDestination.publicKey,
          mint: mint.publicKey,
          amount: new BN(splAmount),
        },
      } as never
    )
    .accountsStrict({
      owner: owner.publicKey,
      config: configPda,
      automation: automationPda,
      mint: mint.publicKey,
      ownerAta,
      automationAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  const tx = new Transaction()
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        destAta,
        splDestination.publicKey,
        mint.publicKey
      )
    )
    .add(
      createAssociatedTokenAccountIdempotentInstruction(
        owner.publicKey,
        automationAta,
        automationPda,
        mint.publicKey
      )
    )
    .add(createIx);
  const createSig = await anchor.web3.sendAndConfirmTransaction(
    conn,
    tx,
    [owner],
    { commitment: "confirmed" }
  );
  console.log("  tx       :", createSig);

  await sleep(2_000);
  console.log("\nWaiting 18s for keeper indexer reconcile (interval=15s)...");
  await sleep(18_000);

  console.log("\nFiring trigger — sending self-transfer from watched...");
  {
    const trig = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: watched.publicKey,
        toPubkey: watched.publicKey,
        lamports: 1,
      })
    );
    const sig = await anchor.web3.sendAndConfirmTransaction(conn, trig, [watched], {
      commitment: "confirmed",
    });
    console.log("  trigger sig :", sig);
  }

  console.log("\nPolling destination ATA balance (timeout 90s)...");
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const bal = await conn
      .getTokenAccountBalance(destAta)
      .catch(() => null);
    if (bal && Number(bal.value.amount) >= splAmount) {
      console.log("\n✅ keeper fired execute_automation_spl");
      console.log("  destination amount :", bal.value.amount);
      const after = await program.account.automation.fetch(automationPda);
      console.log("  executed           :", after.executed);
      process.exit(0);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log("\n❌ timed out — keeper did not execute SPL within 90s");
  process.exit(1);
}

async function runAssetPriceVariant(
  provider: anchor.AnchorProvider,
  program: anchor.Program<SotamaAutomations>,
  conn: anchor.web3.Connection,
  owner: Keypair,
  configPda: PublicKey
) {
  const destination = Keypair.generate();
  console.log("destination :", destination.publicKey.toBase58());

  // Pyth SOL/USD feed (mainnet ID; devnet keeper polls Hermes which
  // serves the same feeds across networks). The on-chain program treats
  // this as opaque metadata.
  const SOL_USD_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
  const feedPubkey = new PublicKey(Buffer.from(SOL_USD_FEED, "hex"));

  // Fire trigger essentially immediately by setting a price ABOVE
  // current SOL price (anything ≥ $0.01 above current works).
  // Comparator 1 = above. Threshold scaled to expo=-8: $0.01 * 10^8 = 10^6.
  const thresholdRaw = new BN(1_000_000);

  const cfg = await program.account.config.fetch(configPda);
  const nonce = BigInt(cfg.automationCount.toString());
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  const [automationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("automation"), owner.publicKey.toBuffer(), nonceBuf],
    program.programId
  );
  const amountLamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);

  console.log(`\nCreating token-price automation #${nonce}...`);
  console.log("  threshold = SOL ABOVE $0.01 (will fire next price tick)");
  const createSig = await program.methods
    .createAutomation(
      {
        assetPrice: {
          feed: feedPubkey,
          quoteMint: null,
          comparator: 1,
          threshold: thresholdRaw,
          expo: -8,
          source: 0, // oracle_source::PYTH
        },
      } as never,
      { transferSol: { destination: destination.publicKey, amount: new BN(amountLamports) } } as never
    )
    .accountsStrict({
      owner: owner.publicKey,
      config: configPda,
      automation: automationPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc({ commitment: "confirmed" });
  console.log("  tx       :", createSig);

  console.log("\nPolling destination balance (timeout 90s)...");
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const bal = await conn.getBalance(destination.publicKey);
    if (bal >= amountLamports) {
      console.log("\n✅ keeper fired execute_automation");
      const after = await program.account.automation.fetch(automationPda);
      console.log("  executed    :", after.executed);
      console.log("  executed_at :", after.executedAt.toString());
      process.exit(0);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log("\n❌ timed out — keeper did not fire token-price within 90s");
  process.exit(1);
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error("e2e failed:", e);
  process.exit(1);
});
