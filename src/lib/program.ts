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

/* SPL/sysvar program addresses used by the v2 ix builders. */
export const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
/** Token-2022 program. Used when the input/output mint is owned by
 *  Token-2022 — ATA derivation seeds and the `token_program` slot on
 *  create_automation_* / close_automation_* must match the mint's
 *  actual owning program, else Anchor's `Interface<TokenInterface>`
 *  rejects with `IncorrectProgramId`. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

/** True iff `program` is one of the two known SPL token programs. */
export function isKnownTokenProgram(program: PublicKey): boolean {
  return program.equals(SPL_TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID);
}

/** Lazy mint → token-program lookup. The keeper has a parallel cache
 *  (`caches::mint_program`); on the FE we typically know the program
 *  from the TokenRef carried in the UI state (resolveToken stamps it
 *  from Jupiter metadata). This helper is the fallback when only the
 *  mint pubkey is available — e.g. enumerating dust ATAs during a
 *  close. Throws if the mint is owned by an unknown program.
 *
 *  One getAccountInfo per call; callers that loop should cache. */
export async function resolveMintTokenProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) {
    throw new Error(`Mint ${mint.toBase58()} does not exist on-chain`);
  }
  if (!isKnownTokenProgram(info.owner)) {
    throw new Error(
      `Mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}; not a known SPL token program`,
    );
  }
  return info.owner;
}

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

/** Legacy-SPL ATA derivation. Kept as the no-argument default for
 *  callers that only ever deal with legacy mints (canonical SOL/USDC
 *  flows, manual entry). Token-2022-capable callers must use
 *  `associatedTokenAddressForProgram` with the resolved program. */
export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
): PublicKey {
  return associatedTokenAddressForProgram(owner, mint, SPL_TOKEN_PROGRAM_ID);
}

/** ATA derivation that takes the token program as a seed. Required
 *  for Token-2022 — its ATAs derive from the Token-2022 program ID,
 *  NOT from the legacy SPL program ID. Without this, every Token-2022
 *  swap/spl create reverts because the address we ship in the ix
 *  doesn't match what `Interface<TokenInterface>` expects.
 *
 *  Mirror of `associated_token_address_for_program` in the keeper. */
export function associatedTokenAddressForProgram(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
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
      assetPrice: {
        feed: PublicKey;
        quoteMint: PublicKey | null;
        comparator: number;
        threshold: BN;
        expo: number;
        /** `oracle_source::PYTH = 0` | `oracle_source::JUPITER = 1`. The
         *  on-chain program is oracle-agnostic; the keeper dispatches to
         *  the matching adapter based on this byte. */
        source: number;
      };
    }
  | {
      timeElapsed: {
        /** Seconds (u32 on-chain) since `Automation.created_at`. */
        durationSecs: number;
      };
    }
  | {
      priceRelativeToFill: {
        /** Upstream automation PDA — the rule whose fill price we compare against. */
        upstream: PublicKey;
        /** 0 = drop_below_fill, 1 = grow_above_fill. */
        direction: number;
        /** Movement threshold in basis points (100 = 1%, 500 = 5%). */
        pctBps: number;
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
      swap: {
        inputMint: PublicKey;
        outputMint: PublicKey;
        destination: PublicKey;
        amountIn: BN;
        minAmountOut: BN;
        linkedDownstream: PublicKey | null;
        linkFeeDeposit: BN;
        consumeUpstreamOutput: boolean;
      };
    };

/** On-chain Cadence variant. Mirrors the Anchor enum verbatim — JS-side
 *  callers should always go through `cadenceToOnChain` from this module
 *  rather than constructing the literal directly. */
export type OnChainCadence =
  | { once: Record<string, never> }
  | { repeat: { total: number } }
  | { until: { unixDeadline: BN } };

import type { Cadence } from "./types";

export function cadenceToOnChain(cadence: Cadence): OnChainCadence {
  switch (cadence.kind) {
    case "once":
      return { once: {} };
    case "repeat":
      return { repeat: { total: cadence.total } };
    case "until":
      return { until: { unixDeadline: new BN(cadence.unixDeadline) } };
  }
}

/* ── Instruction builders ───────────────────────────────────────────── */

export async function buildCreateAutomationIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  /** `Config.keeper` — recipient of the upfront time fee. Fetch via
   *  `fetchConfig(program)` once and pass through. */
  keeper: PublicKey;
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec & { transferSol: { destination: PublicKey; amount: BN } };
  cadence: OnChainCadence;
  minIntervalSecs: number;
  nextNonce: bigint;
}): Promise<{ ix: TransactionInstruction; automation: PublicKey }> {
  const { program, owner, keeper, trigger, action, cadence, minIntervalSecs, nextNonce } = params;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ix = await program.methods
    .createAutomation(trigger as never, action as never, cadence as never, minIntervalSecs)
    .accountsStrict({
      owner,
      config: configPda(program.programId),
      automation,
      keeper,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  return { ix, automation };
}

export async function buildCreateAutomationSplIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  keeper: PublicKey;
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec & {
    transferSpl: { destination: PublicKey; mint: PublicKey; amount: BN };
  };
  cadence: OnChainCadence;
  minIntervalSecs: number;
  nextNonce: bigint;
  /** Token program owning the mint. Defaults to legacy SPL; pass
   *  `TOKEN_2022_PROGRAM_ID` for Token-2022 mints. Anchor enforces
   *  this matches the mint's actual owning program via the
   *  `Interface<TokenInterface>` constraint. */
  tokenProgram?: PublicKey;
}): Promise<{
  ix: TransactionInstruction;
  automation: PublicKey;
  ownerAta: PublicKey;
  automationAta: PublicKey;
}> {
  const {
    program,
    owner,
    keeper,
    trigger,
    action,
    cadence,
    minIntervalSecs,
    nextNonce,
    tokenProgram = SPL_TOKEN_PROGRAM_ID,
  } = params;
  const mint = action.transferSpl.mint;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ownerAta = associatedTokenAddressForProgram(owner, mint, tokenProgram);
  const automationAta = associatedTokenAddressForProgram(automation, mint, tokenProgram);
  const ix = await program.methods
    .createAutomationSpl(trigger as never, action as never, cadence as never, minIntervalSecs)
    .accountsStrict({
      owner,
      config: configPda(program.programId),
      automation,
      mint,
      ownerAta,
      automationAta,
      keeper,
      tokenProgram,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  return { ix, automation, ownerAta, automationAta };
}

export async function buildCreateAutomationSwapIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  keeper: PublicKey;
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec & {
    swap: {
      inputMint: PublicKey;
      outputMint: PublicKey;
      destination: PublicKey;
      amountIn: BN;
      minAmountOut: BN;
    };
  };
  cadence: OnChainCadence;
  minIntervalSecs: number;
  nextNonce: bigint;
  /** Token program owning the input mint. Defaults to legacy SPL.
   *  See `buildCreateAutomationSplIx` for rationale. */
  inputTokenProgram?: PublicKey;
}): Promise<{
  ix: TransactionInstruction;
  automation: PublicKey;
  ownerInputAta: PublicKey;
  automationInputAta: PublicKey;
}> {
  const {
    program,
    owner,
    keeper,
    trigger,
    action,
    cadence,
    minIntervalSecs,
    nextNonce,
    inputTokenProgram = SPL_TOKEN_PROGRAM_ID,
  } = params;
  const inputMint = action.swap.inputMint;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ownerInputAta = associatedTokenAddressForProgram(owner, inputMint, inputTokenProgram);
  const automationInputAta = associatedTokenAddressForProgram(
    automation,
    inputMint,
    inputTokenProgram,
  );
  const ix = await program.methods
    .createAutomationSwap(
      trigger as never,
      action as never,
      cadence as never,
      minIntervalSecs,
      false,
    )
    .accountsStrict({
      owner,
      config: configPda(program.programId),
      automation,
      inputMint,
      ownerInputAta,
      automationInputAta,
      keeper,
      tokenProgram: inputTokenProgram,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  return { ix, automation, ownerInputAta, automationInputAta };
}

/** Build a create-automation ix for a chain-linked Swap. The on-chain
 *  handler takes an explicit `seedAmount` instead of computing the
 *  deposit from `amount_in × total_fires`, and accepts any cadence
 *  (including Until) since the chain self-feeds via `Swap.destination`
 *  routing. Pass `seedAmount = amountIn` for the chain head and
 *  `seedAmount = 0` for downstream rules. */
export async function buildCreateAutomationSwapLinkedIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  keeper: PublicKey;
  trigger: OnChainTriggerSpec;
  action: OnChainActionSpec & {
    swap: {
      inputMint: PublicKey;
      outputMint: PublicKey;
      destination: PublicKey;
      amountIn: BN;
      minAmountOut: BN;
    };
  };
  cadence: OnChainCadence;
  minIntervalSecs: number;
  enableFeeTopup: boolean;
  seedAmount: BN;
  bridgeEnabled: boolean;
  nextNonce: bigint;
  /** Token program owning the input mint. Defaults to legacy SPL. */
  inputTokenProgram?: PublicKey;
}): Promise<{
  ix: TransactionInstruction;
  automation: PublicKey;
  ownerInputAta: PublicKey;
  automationInputAta: PublicKey;
}> {
  const {
    program,
    owner,
    keeper,
    trigger,
    action,
    cadence,
    minIntervalSecs,
    enableFeeTopup,
    seedAmount,
    bridgeEnabled,
    nextNonce,
    inputTokenProgram = SPL_TOKEN_PROGRAM_ID,
  } = params;
  const inputMint = action.swap.inputMint;
  const automation = automationPda(owner, nextNonce, program.programId);
  const ownerInputAta = associatedTokenAddressForProgram(owner, inputMint, inputTokenProgram);
  const automationInputAta = associatedTokenAddressForProgram(
    automation,
    inputMint,
    inputTokenProgram,
  );
  // Anchor types haven't been regenerated since the new ix shipped; use
  // the dynamic methods accessor and cast through unknown so tsc accepts
  // the call. The wire format is the same — name → discriminator lookup
  // is by the IDL's instructions[].name.
  const methods = program.methods as unknown as Record<
    string,
    (
      trigger: unknown,
      action: unknown,
      cadence: unknown,
      minIntervalSecs: number,
      enableFeeTopup: boolean,
      seedAmount: BN,
      bridgeEnabled: boolean,
    ) => {
      accountsStrict: (a: Record<string, PublicKey>) => {
        instruction: () => Promise<TransactionInstruction>;
      };
    }
  >;
  const ix = await methods
    .createAutomationSwapLinked(
      trigger,
      action,
      cadence,
      minIntervalSecs,
      enableFeeTopup,
      seedAmount,
      bridgeEnabled,
    )
    .accountsStrict({
      owner,
      config: configPda(program.programId),
      automation,
      inputMint,
      ownerInputAta,
      automationInputAta,
      keeper,
      tokenProgram: inputTokenProgram,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  return { ix, automation, ownerInputAta, automationInputAta };
}

export async function buildCloseAutomationIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  automation: PublicKey;
  treasury: PublicKey;
}): Promise<TransactionInstruction> {
  const { program, owner, automation, treasury } = params;
  return program.methods
    .closeAutomation()
    .accountsStrict({
      owner,
      automation,
      config: configPda(program.programId),
      treasury,
    })
    .instruction();
}

/** Close an SPL-action automation. Drains the PDA's ATA back to
 *  `ownerAta` (which must exist — caller is expected to prepend an
 *  idempotent ATA-create), closes the ATA, then closes the PDA. */
export async function buildCloseAutomationSplIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  automation: PublicKey;
  mint: PublicKey;
  treasury: PublicKey;
  /** Token program owning `mint`. Defaults to legacy SPL; pass
   *  `TOKEN_2022_PROGRAM_ID` for Token-2022. Mismatch ⇒ on-chain
   *  IncorrectProgramId revert. */
  tokenProgram?: PublicKey;
}): Promise<{
  ix: TransactionInstruction;
  ownerAta: PublicKey;
  automationAta: PublicKey;
}> {
  const {
    program,
    owner,
    automation,
    mint,
    treasury,
    tokenProgram = SPL_TOKEN_PROGRAM_ID,
  } = params;
  const ownerAta = associatedTokenAddressForProgram(owner, mint, tokenProgram);
  const automationAta = associatedTokenAddressForProgram(automation, mint, tokenProgram);
  const ix = await program.methods
    .closeAutomationSpl()
    .accountsStrict({
      owner,
      automation,
      config: configPda(program.programId),
      treasury,
      mint,
      ownerAta,
      automationAta,
      tokenProgram,
    })
    .instruction();
  return { ix, ownerAta, automationAta };
}

/** Close a swap-action automation. Drains the PDA's input ATA back
 *  to `ownerInputAta`, closes the input ATA, then closes the PDA. */
export async function buildCloseAutomationSwapIx(params: {
  program: Program<SotamaAutomations>;
  owner: PublicKey;
  automation: PublicKey;
  inputMint: PublicKey;
  treasury: PublicKey;
  /** Token program owning the input mint. Defaults to legacy SPL. */
  inputTokenProgram?: PublicKey;
}): Promise<{
  ix: TransactionInstruction;
  ownerInputAta: PublicKey;
  automationInputAta: PublicKey;
}> {
  const {
    program,
    owner,
    automation,
    inputMint,
    treasury,
    inputTokenProgram = SPL_TOKEN_PROGRAM_ID,
  } = params;
  const ownerInputAta = associatedTokenAddressForProgram(owner, inputMint, inputTokenProgram);
  const automationInputAta = associatedTokenAddressForProgram(
    automation,
    inputMint,
    inputTokenProgram,
  );
  const ix = await program.methods
    .closeAutomationSwap()
    .accountsStrict({
      owner,
      automation,
      config: configPda(program.programId),
      treasury,
      inputMint,
      ownerInputAta,
      automationInputAta,
      tokenProgram: inputTokenProgram,
    })
    .instruction();
  return { ix, ownerInputAta, automationInputAta };
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
      // IDL field is `automation` (the PDA address), not `pubkey`. The
      // older name shipped before Anchor 0.30's IDL rewrite; preserve
      // both lookups to survive a future IDL rename without crashing.
      const data = evt.data as { automation?: PublicKey; pubkey?: PublicKey; nonce: BN };
      const automationPk = data.automation ?? data.pubkey;
      if (!automationPk) continue;
      return {
        pubkey: automationPk.toBase58(),
        nonce: data.nonce.toString(),
      };
    }
  }
  return null;
}

function mustProgramId(): PublicKey {
  if (!SOTAMA_PROGRAM_ID) {
    throw new Error(
      "NEXT_PUBLIC_SOTAMA_PROGRAM_ID is not set. Configure it in your environment to use Sotama."
    );
  }
  return SOTAMA_PROGRAM_ID;
}
