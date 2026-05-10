/**
 * lifecycle_events.ts
 *
 * Asserts that AutomationCreated, AutomationFinished (reason=0), and
 * AutomationFinished (reason=1) events appear in transaction logs at the
 * right program instructions.
 *
 * Design choices that keep this file order-independent when run together
 * with sotama_automations.ts:
 *   - Uses the provider wallet payer as both admin AND keeper — the same
 *     choice as the main test suite — so `initializeConfig` is effectively
 *     idempotent (if the PDA already exists we just skip it).
 *   - Uses a dedicated `owner` keypair so nonce derivation never collides
 *     with automations created by other suites.
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import { SotamaAutomations } from "../target/types/sotama_automations";

// ── helpers ──────────────────────────────────────────────────────────────────

const automationPdaFor = (
  programId: PublicKey,
  owner: PublicKey,
  nonce: bigint
): PublicKey => {
  const nonceBuf = Buffer.alloc(8);
  nonceBuf.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("automation"), owner.toBuffer(), nonceBuf],
    programId
  )[0];
};

const trigger = {
  accountTransfer: (account: PublicKey) => ({
    accountActivity: { account, mint: null, kind: 0 },
  }),
};

const action = {
  transferSol: (destination: PublicKey, amount: BN) => ({
    transferSol: { destination, amount },
  }),
};

const cadence = {
  once: () => ({ once: {} }),
};

// ── suite ────────────────────────────────────────────────────────────────────

describe("lifecycle events", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.sotamaAutomations as Program<SotamaAutomations>;

  // The provider wallet payer is the localnet admin. Using it as keeper
  // too lets us sign execute calls without holding a second secret key.
  const adminAndKeeper = (provider.wallet as anchor.Wallet).payer;

  // Dedicated owner so nonce 0,1,2 from this suite never alias into the
  // main suite's automations (which uses its own `owner` keypair).
  const owner = Keypair.generate();
  const watched = Keypair.generate();
  const destination = Keypair.generate();

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const fund = async (pk: PublicKey, sol: number) => {
    const sig = await provider.connection.requestAirdrop(
      pk,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");
  };

  before(async () => {
    await fund(owner.publicKey, 10);

    // Only call initializeConfig when the PDA does not yet exist.
    // If it was created by a prior test file (possible when all *.ts run
    // together), we reuse whatever state is there.
    const existing = await provider.connection.getAccountInfo(configPda);
    if (!existing) {
      // Use the provider wallet payer as keeper so we can sign execute calls.
      await program.methods
        .initializeConfig(adminAndKeeper.publicKey)
        .accountsStrict({
          admin: adminAndKeeper.publicKey,
          config: configPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    }
  });

  // ── Test 1: AutomationCreated event ────────────────────────────────────────

  it("emits AutomationCreated on create_automation", async () => {
    const createdEvents: any[] = [];
    const listener = program.addEventListener("automationCreated", (ev) => {
      createdEvents.push(ev);
    });

    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.05 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.once(),
        0 // min_interval_secs
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await new Promise((r) => setTimeout(r, 1500));
    await program.removeEventListener(listener);

    assert.equal(
      createdEvents.length,
      1,
      "expected exactly one AutomationCreated event"
    );
    const ev = createdEvents[0];
    assert.ok(ev.pubkey, "pubkey field present");
    assert.equal(
      ev.owner.toBase58(),
      owner.publicKey.toBase58(),
      "owner matches"
    );
    assert.equal(ev.triggerKind, 0, "trigger_kind = 0 (AccountActivity)");
    assert.equal(ev.cadenceKind, 0, "cadence_kind = 0 (Once)");
    assert.equal(ev.actionKind, 0, "action_kind = 0 (TransferSol)");
  });

  // ── Test 2: AutomationFinished on terminal execute ──────────────────────────

  it("emits AutomationFinished (reason=0) on terminal fire via execute_automation", async () => {
    const finishedEvents: any[] = [];
    const executedEvents: any[] = [];
    const listenerF = program.addEventListener("automationFinished", (ev) => {
      finishedEvents.push(ev);
    });
    const listenerE = program.addEventListener("automationExecuted", (ev) => {
      executedEvents.push(ev);
    });

    // Create a fresh Once automation.
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.05 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.once(),
        0
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Check that the config keeper matches our adminAndKeeper so we can sign.
    const cfgData = await program.account.config.fetch(configPda);
    assert.equal(
      cfgData.keeper.toBase58(),
      adminAndKeeper.publicKey.toBase58(),
      "keeper is provider wallet — required to sign execute_automation"
    );

    // Execute — Once cadence fires once then becomes terminal.
    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: adminAndKeeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .rpc(); // provider wallet signs automatically

    await new Promise((r) => setTimeout(r, 1500));
    await program.removeEventListener(listenerF);
    await program.removeEventListener(listenerE);

    // AutomationExecuted should surface with finished=true
    assert.equal(executedEvents.length, 1, "one AutomationExecuted event");
    assert.equal(
      executedEvents[0].finished,
      true,
      "AutomationExecuted.finished is true"
    );

    // AutomationFinished should follow with reason=0
    assert.equal(finishedEvents.length, 1, "one AutomationFinished event");
    assert.equal(finishedEvents[0].reason, 0, "reason = 0 (fired_terminal)");
    assert.ok(finishedEvents[0].automation, "automation pubkey present");
    assert.equal(
      finishedEvents[0].automation.toBase58(),
      auto.toBase58(),
      "automation pubkey matches"
    );
  });

  // ── Test 3: AutomationFinished on close ────────────────────────────────────

  it("emits AutomationFinished (reason=1) on close_automation", async () => {
    const finishedEvents: any[] = [];
    const closedEvents: any[] = [];
    const listenerF = program.addEventListener("automationFinished", (ev) => {
      finishedEvents.push(ev);
    });
    const listenerC = program.addEventListener("automationClosed", (ev) => {
      closedEvents.push(ev);
    });

    // Create a new Once automation.
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.05 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.once(),
        0
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Close it — should emit AutomationFinished(reason=1) then AutomationClosed.
    const cfgData = await program.account.config.fetch(configPda);
    await program.methods
      .closeAutomation()
      .accountsStrict({
        owner: owner.publicKey,
        automation: auto,
        config: configPda,
        treasury: cfgData.treasury,
      })
      .signers([owner])
      .rpc();

    await new Promise((r) => setTimeout(r, 1500));
    await program.removeEventListener(listenerF);
    await program.removeEventListener(listenerC);

    assert.equal(closedEvents.length, 1, "one AutomationClosed event");
    assert.equal(finishedEvents.length, 1, "one AutomationFinished event");
    assert.equal(finishedEvents[0].reason, 1, "reason = 1 (closed)");
    assert.equal(
      finishedEvents[0].automation.toBase58(),
      auto.toBase58(),
      "automation pubkey matches"
    );
  });
});
