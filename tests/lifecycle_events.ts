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
  until: (unixDeadline: BN) => ({ until: { unixDeadline } }),
  repeat: (total: number) => ({ repeat: { total } }),
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
    assert.equal(ev.automation.toBase58(), auto.toBase58(), "automation field matches created PDA");
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

  // ── Test 4: AutomationFinished on Until-deadline expiry ───────────────────

  it("emits AutomationFinished (reason=0) and sets finished when Until deadline has passed", async () => {
    const finishedEvents: any[] = [];
    const listenerF = program.addEventListener("automationFinished", (ev) => {
      finishedEvents.push(ev);
    });

    // Create an Until automation with a deadline 1 second in the future.
    // create_automation requires unix_deadline > now; we use now+1 to satisfy
    // that. The deadline will be in the past by the time the create tx
    // confirms (~400 ms) and the execute tx is submitted (~400 ms more), so
    // is_until_expired fires on the first execute without any explicit sleep.
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.05 * LAMPORTS_PER_SOL);

    // Read the on-chain clock so the deadline is relative to validator time,
    // not wall-clock time. This avoids failures when the validator lags
    // wall-clock (which can happen on heavily-loaded CI machines).
    const clockSlot = await provider.connection.getSlot("confirmed");
    const onChainNow = (await provider.connection.getBlockTime(clockSlot))!;
    // Set deadline 2 seconds ahead of on-chain time — passes create_automation's
    // unix_deadline > now check by exactly 2 seconds on the validator's own clock.
    const pastDeadline = new BN(onChainNow + 2);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.until(pastDeadline),
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

    // Wait 3 s so the on-chain clock advances past the onChainNow+2 deadline.
    // solana-test-validator ticks ~400 ms/slot; 3 s ≈ 7–8 slots — reliably
    // past a 2-second deadline based on the validator's own timestamp.
    await new Promise((r) => setTimeout(r, 3000));

    // Execute — deadline has passed so the handler should terminate without
    // firing the action and emit AutomationFinished(reason=0).
    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: adminAndKeeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .rpc();

    await new Promise((r) => setTimeout(r, 1500));
    await program.removeEventListener(listenerF);

    // AutomationFinished with reason=0 must have been emitted.
    assert.equal(
      finishedEvents.length,
      1,
      "one AutomationFinished event for Until-deadline expiry"
    );
    assert.equal(
      finishedEvents[0].reason,
      0,
      "reason = 0 (terminal — Until deadline reached)"
    );
    assert.equal(
      finishedEvents[0].automation.toBase58(),
      auto.toBase58(),
      "automation pubkey matches"
    );

    // The on-chain account must have finished = true.
    const acct = await program.account.automation.fetch(auto);
    assert.equal(
      acct.finished,
      true,
      "automation.finished is true after Until deadline expiry"
    );
  });

  // ── Test 5b: PriceRelativeToFill round-trip ───────────────────────────────

  it("stores and round-trips a PriceRelativeToFill trigger variant", async () => {
    // Use a random upstream pubkey — on-chain only stores it, never reads it.
    const upstream = Keypair.generate().publicKey;

    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.05 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        // PriceRelativeToFill variant: direction=1 (grow_above_fill), pct_bps=500 (5%)
        { priceRelativeToFill: { upstream, direction: 1, pctBps: 500 } },
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

    // Fetch the account and confirm the trigger round-trips correctly.
    const acct = await program.account.automation.fetch(auto);
    const t = acct.trigger as any;
    assert.ok(t.priceRelativeToFill, "trigger variant is priceRelativeToFill");
    assert.equal(
      t.priceRelativeToFill.upstream.toBase58(),
      upstream.toBase58(),
      "upstream pubkey round-trips"
    );
    assert.equal(t.priceRelativeToFill.direction, 1, "direction = 1 (grow_above_fill)");
    assert.equal(t.priceRelativeToFill.pctBps, 500, "pct_bps = 500 (5%)");
  });

  // ── Test 5: AutomationFinished on Repeat-cadence exhaustion ──────────────

  it("emits AutomationFinished (reason=0) only on the second fire of a Repeat{total:2} automation", async () => {
    const finishedEvents: any[] = [];
    const executedEvents: any[] = [];
    const listenerF = program.addEventListener("automationFinished", (ev) => {
      finishedEvents.push(ev);
    });
    const listenerE = program.addEventListener("automationExecuted", (ev) => {
      executedEvents.push(ev);
    });

    // Create a Repeat { total: 2 } automation.
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.05 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.repeat(2),
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

    // Top up the PDA with one extra fire's worth of lamports. create_automation
    // deposits only `amount` (enough for one fire); Repeat{total:2} needs 2×.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(auto, amount.toNumber()),
      "confirmed"
    );

    // First fire — should NOT emit AutomationFinished (executions=1, total=2).
    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: adminAndKeeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .rpc();

    await new Promise((r) => setTimeout(r, 1500));

    assert.equal(
      finishedEvents.length,
      0,
      "no AutomationFinished after first fire of Repeat{total:2}"
    );
    assert.equal(
      executedEvents.length,
      1,
      "one AutomationExecuted after first fire"
    );
    assert.equal(
      executedEvents[0].finished,
      false,
      "AutomationExecuted.finished is false after first fire"
    );

    // Second fire — should emit AutomationFinished(reason=0).
    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: adminAndKeeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .rpc();

    await new Promise((r) => setTimeout(r, 1500));
    await program.removeEventListener(listenerF);
    await program.removeEventListener(listenerE);

    assert.equal(
      finishedEvents.length,
      1,
      "one AutomationFinished after second fire of Repeat{total:2}"
    );
    assert.equal(finishedEvents[0].reason, 0, "reason = 0 (fired_terminal)");
    assert.equal(
      finishedEvents[0].automation.toBase58(),
      auto.toBase58(),
      "automation pubkey matches"
    );
    assert.equal(
      executedEvents.length,
      2,
      "two AutomationExecuted events total"
    );
    assert.equal(
      executedEvents[1].finished,
      true,
      "AutomationExecuted.finished is true on second fire"
    );

    // The on-chain account must have finished = true.
    const acctFinal = await program.account.automation.fetch(auto);
    assert.equal(
      acctFinal.finished,
      true,
      "automation.finished is true after Repeat cadence exhaustion"
    );
  });
});
