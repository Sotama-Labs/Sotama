"use client";

import {
  Connection,
  PublicKey,
  Transaction,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Automation } from "@/lib/types";
import {
  buildCloseAutomationIx,
  buildCloseAutomationSplIx,
  buildCloseAutomationSwapIx,
  configPda,
  fetchConfig,
  getProgram,
  SPL_TOKEN_PROGRAM_ID,
} from "@/lib/program";

/**
 * Submit the right `close_automation*` ix for `target`'s action kind.
 * Refunds the deposit (SPL or wSOL → owner's ATA, native SOL → owner's
 * lamports) and closes the on-chain Automation account so the user
 * recovers rent + remaining balance.
 *
 * Routing:
 *   - `transfer` (SOL): plain `close_automation` — Anchor's
 *     `close = owner` returns the PDA's lamport balance directly.
 *   - `transfer` (SPL): `close_automation_spl` — drains automation's
 *     ATA → owner's ATA, closes ATA, closes PDA.
 *   - `swap`: `close_automation_swap` — drains automation's input
 *     ATA → owner's input ATA, closes input ATA, closes PDA.
 *
 * For SPL/swap closes the owner's destination ATA is idempotent-created
 * in the same tx so the close-handler's `Account<TokenAccount>` decode
 * can't fail when the user has never received that mint before.
 */
export async function closeAutomationOnChain(
  connection: Connection,
  wallet: {
    publicKey: PublicKey | null;
    signTransaction: NonNullable<
      import("@solana/wallet-adapter-react").WalletContextState["signTransaction"]
    >;
  },
  target: Automation,
): Promise<string> {
  if (!wallet.publicKey) throw new Error("wallet not connected");
  if (!target.pubkey) {
    throw new Error("automation has no on-chain pubkey — nothing to close");
  }

  // Find the action with a deposit so we know which close-ix to use.
  // Multi-action chains haven't shipped on-chain yet — the pubkey on
  // file always corresponds to the first action's create handler.
  const action = target.actions[0];
  if (!action) throw new Error("automation has no actions");

  const owner = wallet.publicKey;
  const automation = new PublicKey(target.pubkey);
  const adapterWallet = {
    publicKey: owner,
    signTransaction: wallet.signTransaction,
    signAllTransactions: async <T extends { partialSign: (...s: unknown[]) => void }>(
      txs: T[],
    ) =>
      Promise.all(
        txs.map((t) => wallet.signTransaction(t as never)),
      ) as unknown as T[],
    payer: undefined as never,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const program = getProgram(connection, adapterWallet as any);

  const tx = new Transaction();
  const SOL_MINT = "So11111111111111111111111111111111111111112";

  // Fetch on-chain Config once so every close branch passes the same
  // treasury account. Config rarely rotates, so a per-close fetch is
  // fine (cached at the next layer up if perf becomes an issue).
  const config = await fetchConfig(program);
  const treasury = config.treasury;

  if (action.kind === "transfer" && action.token.mint !== SOL_MINT) {
    const mint = new PublicKey(action.token.mint);
    const built = await buildCloseAutomationSplIx({
      program,
      owner,
      automation,
      mint,
      treasury,
    });
    tx.add(prependOwnerAtaCreate(owner, built.ownerAta, mint));
    tx.add(built.ix);
  } else if (action.kind === "swap") {
    const inputMint = new PublicKey(action.inputToken.mint);
    const built = await buildCloseAutomationSwapIx({
      program,
      owner,
      automation,
      inputMint,
      treasury,
    });
    tx.add(prependOwnerAtaCreate(owner, built.ownerInputAta, inputMint));

    // Enumerate any non-input-mint ATAs the PDA may hold (dust from a
    // bridge that failed mid-flight, stale chain output, etc.) and pass
    // each (pda_ata, owner_ata) pair as remaining accounts so the
    // on-chain handler drains and closes them. For each, idempotently
    // create the owner's same-mint ATA so the on-chain `transfer` CPI
    // has a valid destination.
    const dust = await collectPdaDustAtas(connection, automation, inputMint);
    const remaining: AccountMeta[] = [];
    for (const { pdaAta, mint } of dust) {
      const ownerForeignAta = getAssociatedTokenAddressSync(mint, owner);
      tx.add(prependOwnerAtaCreate(owner, ownerForeignAta, mint));
      remaining.push({ pubkey: pdaAta, isSigner: false, isWritable: true });
      remaining.push({ pubkey: ownerForeignAta, isSigner: false, isWritable: true });
    }
    if (remaining.length === 0) {
      tx.add(built.ix);
    } else {
      // Re-build the ix with remainingAccounts attached.
      const ixWithRemaining = await program.methods
        .closeAutomationSwap()
        .accountsStrict({
          owner,
          automation,
          config: configPda(program.programId),
          treasury,
          inputMint,
          ownerInputAta: built.ownerInputAta,
          automationInputAta: built.automationInputAta,
          tokenProgram: SPL_TOKEN_PROGRAM_ID,
        })
        .remainingAccounts(remaining)
        .instruction();
      tx.add(ixWithRemaining);
    }
  } else {
    // SOL transfer — no ATA refund needed; plain close.
    const ix = await buildCloseAutomationIx({ program, owner, automation, treasury });
    tx.add(ix);
  }

  tx.feePayer = owner;
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

function prependOwnerAtaCreate(
  owner: PublicKey,
  ownerAta: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    owner,
    ownerAta,
    owner,
    mint,
    SPL_TOKEN_PROGRAM_ID,
  );
}

/**
 * Enumerate all SPL token accounts owned by the automation PDA whose
 * mint differs from `inputMint`. These are dust ATAs the on-chain
 * close handler will drain into the owner's same-mint ATA.
 *
 * Filters out:
 *   - the input ATA (handled directly by the close handler).
 *   - any non-ATA token accounts (we only handle the canonical
 *     associated-token-account derivation; non-ATA accounts wouldn't
 *     have been created by Sotama's flows and shouldn't accumulate).
 */
async function collectPdaDustAtas(
  connection: Connection,
  pda: PublicKey,
  inputMint: PublicKey,
): Promise<{ pdaAta: PublicKey; mint: PublicKey }[]> {
  const accounts = await connection.getTokenAccountsByOwner(pda, {
    programId: SPL_TOKEN_PROGRAM_ID,
  });
  const out: { pdaAta: PublicKey; mint: PublicKey }[] = [];
  for (const a of accounts.value) {
    // Mint pubkey lives at offset 0 of the SPL token account layout.
    const mint = new PublicKey(a.account.data.subarray(0, 32));
    if (mint.equals(inputMint)) continue;
    // Confirm the account is the canonical ATA for (pda, mint); if a
    // non-ATA token account ever appeared we'd skip it (the on-chain
    // handler validates owner+mint anyway, but mismatched ATA derivation
    // would cause downstream caller assumptions to break).
    const expectedAta = getAssociatedTokenAddressSync(
      mint,
      pda,
      true,
      SPL_TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    );
    if (!expectedAta.equals(a.pubkey)) continue;
    out.push({ pdaAta: a.pubkey, mint });
  }
  return out;
}
