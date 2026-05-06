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
  ((IDL as { address?: string }).address ?? null);

export const SOTAMA_PROGRAM_ID: PublicKey | null = SOTAMA_PROGRAM_ID_STR
  ? new PublicKey(SOTAMA_PROGRAM_ID_STR)
  : null;

export const PROGRAM_CLUSTER: Cluster = CLUSTER;

/* SPL/stake/sysvar program addresses used by the v2 ix builders. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

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

/** Off-curve ATA derivation. Used both for the automation PDA's holding
 *  account (SPL transfer source) and for destination wallets. */
export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), SPL_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

export function getProgram(
  connection: Connection,
  wallet: Wallet
): Program<SotamaAutomations> {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  return new Program<SotamaAutomations>(IDL as unknown as SotamaAutomations, provider);
}

/* ── TriggerSpec / ActionSpec constructors ──────────────────────────── */

export type OnChainTriggerSpec =
  | {
      accountActivity: {
        account: PublicKey;
        mint: PublicKey | null;
        kind: number;
      };
    }
  | {
      tokenPrice: {
        feed: PublicKey;
        comparator: number;
        threshold: BN;
        expo: number;
      };
    }
  | {
      stakingReward: {
        stakeAccount: PublicKey;
        mode: number;
        value: BN;
      };
    };

export type OnChainActionSpec =
  | { transferSol: { destination: PublicKey; amount: BN } }
  | {
      transferSpl: {
        destination: PublicKey;
        mint: PublicKey;
        amount: BN;
      };
    }
  | {
      stakeRestake: {
        stakeAccount: PublicKey;
        voteAccount: PublicKey;
      };
    }
  | {
      stakeWithdrawReward: {
        stakeAccount: PublicKey;
        destination: PublicKey;
      };
    };

/* ── Instruction builders ───────────────────────────────────────────── */

export async function buildCreateAutomationIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec & { transferSol: { destination: PublicKey; amount: BN } };
  nextNonce: bigint;
}): Promise<{ ix: TransactionInstruction; automation: PublicKey }> {
  const { program, owner, trigger, action, nextNonce } = params;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ix = await program.methods
    .createAutomation(trigger as never, action as never)
    .accountsStrict({
      owner,
      config: configPda(program.programId),
      automation,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  return { ix, automation };
}

export async function buildCreateAutomationSplIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec & {
    transferSpl: { destination: PublicKey; mint: PublicKey; amount: BN };
  };
  nextNonce: bigint;
}): Promise<{
  ix: TransactionInstruction;
  automation: PublicKey;
  ownerAta: PublicKey;
  automationAta: PublicKey;
}> {
  const { program, owner, trigger, action, nextNonce } = params;
  const mint = action.transferSpl.mint;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ownerAta = associatedTokenAddress(owner, mint);
  const automationAta = associatedTokenAddress(automation, mint);
  const ix = await program.methods
    .createAutomationSpl(trigger as never, action as never)
    .accountsStrict({
      owner,
      config: configPda(program.programId),
      automation,
      mint,
      ownerAta,
      automationAta,
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  return { ix, automation, ownerAta, automationAta };
}

export async function buildCreateAutomationStakeIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec;
  nextNonce: bigint;
}): Promise<{ ix: TransactionInstruction; automation: PublicKey }> {
  const { program, owner, trigger, action, nextNonce } = params;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ix = await program.methods
    .createAutomationStake(trigger as never, action as never)
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

export async function fetchConfig(program: Program<SotamaAutomations>) {
  return program.account.config.fetch(configPda(program.programId));
}

export async function nextNonce(program: Program<SotamaAutomations>): Promise<bigint> {
  const cfg = await fetchConfig(program);
  return BigInt(cfg.automationCount.toString());
}

/** Parse `AutomationCreated` event from a confirmed transaction's logs.
 *  The v2 event is keyed on `pubkey` + `nonce` regardless of trigger
 *  variant. */
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
