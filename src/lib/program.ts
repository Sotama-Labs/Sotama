/* ─────────────────────────────────────────────────────────────────────
   Sotama on-chain automation program — frontend client.
   Wraps @coral-xyz/anchor + the generated IDL/types so the rest of the
   app can build instructions, sign txs, and parse emitted events
   without re-deriving discriminators or PDA seeds.
   ───────────────────────────────────────────────────────────────────── */

import {
  AnchorProvider,
  BN,
  BorshCoder,
  EventParser,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import IDL from "./idl/sotama_automations.json";
import type { SotamaAutomations } from "./idl/sotama_automations";
import { CLUSTER, type Cluster } from "./rpc";

export const SOTAMA_PROGRAM_ID_STR: string | null =
  process.env.NEXT_PUBLIC_SOTAMA_PROGRAM_ID ||
  // Fallback to the IDL's declared address — handy for local dev when the
  // env var isn't set yet.
  ((IDL as { address?: string }).address ?? null);

export const SOTAMA_PROGRAM_ID: PublicKey | null = SOTAMA_PROGRAM_ID_STR
  ? new PublicKey(SOTAMA_PROGRAM_ID_STR)
  : null;

export const PROGRAM_CLUSTER: Cluster = CLUSTER;

export function isProgramConfigured(): boolean {
  return Boolean(SOTAMA_PROGRAM_ID);
}

export function configPda(programId: PublicKey = mustProgramId()): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

export function automationPda(
  owner: PublicKey,
  nonce: bigint | number,
  programId: PublicKey = mustProgramId()
): PublicKey {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(typeof nonce === "bigint" ? nonce : BigInt(nonce));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("automation"), owner.toBuffer(), nonceBuf],
    programId
  )[0];
}

/** Returns an AnchorProvider + Program bound to the given connection + wallet.
 *  Throws if the program ID isn't configured. */
export function getProgram(
  connection: Connection,
  wallet: Wallet
): Program<SotamaAutomations> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  // Anchor 0.30+ pulls the address from the IDL's `address` field.
  return new Program<SotamaAutomations>(IDL as unknown as SotamaAutomations, provider);
}

/** Build an unsigned `create_automation` instruction. The frontend then
 *  wraps it in a Transaction and asks the wallet to sign+send. */
export async function buildCreateAutomationIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  watchedAccount: PublicKey;
  destination: PublicKey;
  amountLamports: bigint;
  nextNonce: bigint;
}): Promise<{ ix: TransactionInstruction; automation: PublicKey }> {
  const { program, owner, watchedAccount, destination, amountLamports, nextNonce } = params;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ix = await program.methods
    .createAutomation(watchedAccount, destination, new BN(amountLamports.toString()))
    .accountsStrict({
      owner,
      config: configPda(program.programId),
      automation,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  return { ix, automation };
}

export async function buildCloseAutomationIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  automation: PublicKey;
}): Promise<TransactionInstruction> {
  const { program, owner, automation } = params;
  return program.methods
    .closeAutomation()
    .accountsStrict({ owner, automation })
    .instruction();
}

/** Read on-chain Config (admin / keeper / paused / counter). */
export async function fetchConfig(program: Program<SotamaAutomations>) {
  return program.account.config.fetch(configPda(program.programId));
}

/** Returns the next automation nonce by reading Config.automationCount. */
export async function nextNonce(program: Program<SotamaAutomations>): Promise<bigint> {
  const cfg = await fetchConfig(program);
  return BigInt(cfg.automationCount.toString());
}

/** Parse `AutomationCreated` event from a confirmed transaction's logs.
 *  Returns the on-chain pubkey + nonce of the freshly created automation,
 *  or null if no event was emitted (which usually means the tx didn't
 *  actually create one). */
export function parseAutomationCreated(
  program: Program<SotamaAutomations>,
  logs: string[]
): { pubkey: string; nonce: string } | null {
  const coder = new BorshCoder(program.idl as Idl);
  const parser = new EventParser(program.programId, coder);
  for (const evt of parser.parseLogs(logs)) {
    if (evt.name === "AutomationCreated" || evt.name === "automationCreated") {
      const data = evt.data as { pubkey: PublicKey; nonce: BN };
      return {
        pubkey: data.pubkey.toBase58(),
        nonce: data.nonce.toString(),
      };
    }
  }
  return null;
}

function mustProgramId(): PublicKey {
  if (!SOTAMA_PROGRAM_ID) {
    throw new Error(
      "NEXT_PUBLIC_SOTAMA_PROGRAM_ID is not set. Run `pnpm anchor:deploy:devnet` and copy the program ID into .env.local."
    );
  }
  return SOTAMA_PROGRAM_ID;
}
