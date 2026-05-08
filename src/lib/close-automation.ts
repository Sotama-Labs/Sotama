"use client";

import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import type { Automation } from "@/lib/types";
import {
  buildCloseAutomationIx,
  buildCloseAutomationSplIx,
  buildCloseAutomationSwapIx,
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
 *   - `restake`, `transfer_reward`, `sell_for`: stake-side actions
 *     don't escrow tokens in the PDA's ATA; plain `close_automation`
 *     suffices. The destination ATA owned by the user wallet is not
 *     touched.
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
    tx.add(built.ix);
  } else {
    // SOL transfer, restake, transfer_reward, sell_for — no ATA
    // refund needed; plain close.
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
