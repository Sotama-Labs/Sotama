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
  associatedTokenAddressForProgram,
  buildCloseAutomationIx,
  buildCloseAutomationSplIx,
  buildCloseAutomationSwapIx,
  configPda,
  fetchConfig,
  getProgram,
  resolveMintTokenProgram,
  SOTAMA_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@/lib/program";
import { isDemoMode } from "@/lib/demo/demo";

/** Thrown when the on-chain account at `target.pubkey` exists but is
 *  owned by a different program than the currently-configured Sotama
 *  program ID. This happens after a devnet program rotation — automations
 *  created against the previous program ID become unreachable from the
 *  new program. The page-level handler should catch this, drop the
 *  local record, and surface a clear message to the user. */
export class OrphanedAutomationError extends Error {
  readonly automationPubkey: string;
  readonly actualOwner: string;
  readonly expectedOwner: string;
  constructor(args: {
    automationPubkey: string;
    actualOwner: string;
    expectedOwner: string;
  }) {
    super(
      `Automation ${args.automationPubkey} is owned by ${args.actualOwner}, ` +
        `but the current program is ${args.expectedOwner}. The PDA is from a ` +
        `prior program version and cannot be closed by this build.`,
    );
    this.name = "OrphanedAutomationError";
    this.automationPubkey = args.automationPubkey;
    this.actualOwner = args.actualOwner;
    this.expectedOwner = args.expectedOwner;
  }
}

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

  // Demo mode: simulate the close (refund) without touching the chain.
  // The caller marks the record closed locally on a non-throwing return.
  if (isDemoMode()) {
    return "DemoCloseSig1111111111111111111111111111111111111111111111111111111111";
  }

  // Find the action with a deposit so we know which close-ix to use.
  // Multi-action chains haven't shipped on-chain yet — the pubkey on
  // file always corresponds to the first action's create handler.
  const action = target.actions[0];
  if (!action) throw new Error("automation has no actions");

  const owner = wallet.publicKey;
  const automation = new PublicKey(target.pubkey);

  // Pre-flight: confirm the on-chain account is still owned by the
  // current program. After a devnet program rotation, PDAs created
  // against the previous program ID are owned by the abandoned program
  // and would fail with AccountOwnedByWrongProgram (Anchor 3007). Catch
  // it here and surface a structured error so the caller can drop the
  // local record gracefully instead of leaving the user stuck.
  if (!SOTAMA_PROGRAM_ID) {
    throw new Error("Sotama program ID is not configured");
  }
  const expectedOwner = SOTAMA_PROGRAM_ID;
  const acctInfo = await connection.getAccountInfo(automation, "confirmed");
  if (acctInfo == null) {
    // Account doesn't exist on-chain — already closed via some other
    // path. Treat as orphaned so the local record gets cleaned up.
    throw new OrphanedAutomationError({
      automationPubkey: target.pubkey,
      actualOwner: "(account does not exist)",
      expectedOwner: expectedOwner.toBase58(),
    });
  }
  if (!acctInfo.owner.equals(expectedOwner)) {
    throw new OrphanedAutomationError({
      automationPubkey: target.pubkey,
      actualOwner: acctInfo.owner.toBase58(),
      expectedOwner: expectedOwner.toBase58(),
    });
  }

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
    // Detect the mint's token program — TokenRef carries it when known,
    // else probe the mint account directly. Determines both the ATA
    // derivation seed AND the token_program slot on the close ix.
    const tokenProgram = await pickTokenProgram(connection, action.token.tokenProgram, mint);
    const built = await buildCloseAutomationSplIx({
      program,
      owner,
      automation,
      mint,
      treasury,
      tokenProgram,
    });
    tx.add(prependOwnerAtaCreate(owner, built.ownerAta, mint, tokenProgram));
    tx.add(built.ix);
  } else if (action.kind === "swap") {
    const inputMint = new PublicKey(action.inputToken.mint);
    const inputTokenProgram = await pickTokenProgram(
      connection,
      action.inputToken.tokenProgram,
      inputMint,
    );
    const built = await buildCloseAutomationSwapIx({
      program,
      owner,
      automation,
      inputMint,
      treasury,
      inputTokenProgram,
    });
    tx.add(prependOwnerAtaCreate(owner, built.ownerInputAta, inputMint, inputTokenProgram));

    // Enumerate any non-input-mint ATAs the PDA may hold (dust from a
    // bridge that failed mid-flight, stale chain output, etc.). The
    // on-chain handler now expects triples (pda_ata, owner_ata, mint)
    // per dust entry because transfer_checked needs the mint+decimals.
    // We also scan BOTH the legacy SPL and Token-2022 programs because
    // a Token-2022 dust mint lives in its own getTokenAccountsByOwner
    // namespace; missing it would leave funds stranded.
    const dust = await collectPdaDustAtas(connection, automation, inputMint);
    const remaining: AccountMeta[] = [];
    for (const { pdaAta, mint, tokenProgram } of dust) {
      const ownerForeignAta = associatedTokenAddressForProgram(owner, mint, tokenProgram);
      tx.add(prependOwnerAtaCreate(owner, ownerForeignAta, mint, tokenProgram));
      remaining.push({ pubkey: pdaAta, isSigner: false, isWritable: true });
      remaining.push({ pubkey: ownerForeignAta, isSigner: false, isWritable: true });
      // Mint account — newly required by close_automation_swap so
      // transfer_checked can read decimals. Not writable, not signer.
      remaining.push({ pubkey: mint, isSigner: false, isWritable: false });
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
          tokenProgram: inputTokenProgram,
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
  tokenProgram: PublicKey = SPL_TOKEN_PROGRAM_ID,
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    owner,
    ownerAta,
    owner,
    mint,
    tokenProgram,
  );
}

/** Resolve a mint's token program from cached TokenRef metadata if
 *  available, else probe on-chain. Used by the close path where the
 *  TokenRef might predate the Token-2022 unblock (in which case
 *  tokenProgram is undefined). */
async function pickTokenProgram(
  connection: Connection,
  cached: string | undefined,
  mint: PublicKey,
): Promise<PublicKey> {
  if (cached) {
    return new PublicKey(cached);
  }
  return resolveMintTokenProgram(connection, mint);
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
): Promise<{ pdaAta: PublicKey; mint: PublicKey; tokenProgram: PublicKey }[]> {
  // Scan BOTH the legacy SPL and Token-2022 namespaces — each program
  // exposes a separate ATA universe for the same wallet, and missing
  // either would leave dust stranded after close.
  const out: { pdaAta: PublicKey; mint: PublicKey; tokenProgram: PublicKey }[] = [];
  for (const tokenProgram of [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accounts = await connection.getTokenAccountsByOwner(pda, {
      programId: tokenProgram,
    });
    for (const a of accounts.value) {
      // Mint pubkey lives at offset 0 of both legacy SPL and Token-2022
      // token-account layouts (the base account structure is identical).
      const mint = new PublicKey(a.account.data.subarray(0, 32));
      if (mint.equals(inputMint)) continue;
      // Confirm the account is the canonical ATA for (pda, mint,
      // tokenProgram). Non-canonical accounts would cause downstream
      // caller derivations to disagree with what's on-chain.
      const expectedAta = getAssociatedTokenAddressSync(
        mint,
        pda,
        true,
        tokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );
      if (!expectedAta.equals(a.pubkey)) continue;
      out.push({ pdaAta: a.pubkey, mint, tokenProgram });
    }
  }
  return out;
}
