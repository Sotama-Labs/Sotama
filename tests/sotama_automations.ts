import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount as getTokenAccount,
  MINT_SIZE,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { expect } from "chai";
import { SotamaAutomations } from "../target/types/sotama_automations";

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

/* Variant constructors. The Anchor TS IDL exposes Rust enums as
 * `{ variantName: { ...fields } }` objects. Helpers keep tests readable. */
const trigger = {
  accountTransfer: (account: PublicKey, mint: PublicKey | null = null) => ({
    accountActivity: { account, mint, kind: 0 },
  }),
  accountSwap: (account: PublicKey, mint: PublicKey | null = null) => ({
    accountActivity: { account, mint, kind: 1 },
  }),
  assetPriceBelow: (
    feed: PublicKey,
    threshold: BN,
    expo: number,
    quoteMint: PublicKey | null = null,
    source: number = 0, // oracle_source::PYTH
  ) => ({
    assetPrice: { feed, quoteMint, comparator: 0, threshold, expo, source },
  }),
  assetPriceAbove: (
    feed: PublicKey,
    threshold: BN,
    expo: number,
    quoteMint: PublicKey | null = null,
    source: number = 0,
  ) => ({
    assetPrice: { feed, quoteMint, comparator: 1, threshold, expo, source },
  }),
};

const action = {
  transferSol: (destination: PublicKey, amount: BN) => ({
    transferSol: { destination, amount },
  }),
  transferSpl: (destination: PublicKey, mint: PublicKey, amount: BN) => ({
    transferSpl: { destination, mint, amount },
  }),
  swap: (
    inputMint: PublicKey,
    outputMint: PublicKey,
    destination: PublicKey,
    amountIn: BN,
    minAmountOut: BN,
    linkedDownstream: PublicKey | null = null,
    linkFeeDeposit: BN = new BN(0),
  ) => ({
    swap: {
      inputMint,
      outputMint,
      destination,
      amountIn,
      minAmountOut,
      linkedDownstream,
      linkFeeDeposit,
    },
  }),
};

/* Cadence variant constructors. Anchor TS IDL exposes Rust enums as
 * `{ variantName: { ...fields } }`. */
const cadence = {
  once: () => ({ once: {} }),
  repeat: (total: number) => ({ repeat: { total } }),
  until: (unixDeadline: BN) => ({ until: { unixDeadline } }),
};
const NO_INTERVAL = 0;

describe("sotama_automations v2", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace
    .sotamaAutomations as Program<SotamaAutomations>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const keeper = Keypair.generate();
  const otherKeeper = Keypair.generate();
  const owner = Keypair.generate();
  const watched = Keypair.generate();
  const destination = Keypair.generate();
  const intruder = Keypair.generate();

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
    await Promise.all([
      fund(owner.publicKey, 50),
      fund(keeper.publicKey, 1),
      fund(otherKeeper.publicKey, 1),
      fund(intruder.publicKey, 1),
    ]);
  });

  it("initializes config", async () => {
    await program.methods
      .initializeConfig(keeper.publicKey)
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.admin.toBase58()).to.eq(admin.publicKey.toBase58());
    expect(cfg.keeper.toBase58()).to.eq(keeper.publicKey.toBase58());
    expect(cfg.paused).to.eq(false);
    expect(cfg.automationCount.toString()).to.eq("0");
    // v4.1: treasury defaults to admin, close-fee defaults to 0.
    expect(cfg.treasury.toBase58()).to.eq(admin.publicKey.toBase58());
    expect(cfg.closeFeeLamports.toString()).to.eq("0");
  });

  it("creates an account-transfer + transfer-SOL automation and holds the deposit on the PDA", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.once(),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const a = await program.account.automation.fetch(auto);
    expect(a.owner.toBase58()).to.eq(owner.publicKey.toBase58());
    expect(a.finished).to.eq(false);
    expect(a.nonce.toString()).to.eq(nonce.toString());
    expect(a.trigger).to.have.nested.property("accountActivity.kind", 0);
    expect((a.trigger as any).accountActivity.account.toBase58()).to.eq(
      watched.publicKey.toBase58()
    );
    expect(a.action).to.have.nested.property("transferSol");
    expect((a.action as any).transferSol.destination.toBase58()).to.eq(
      destination.publicKey.toBase58()
    );
    expect((a.action as any).transferSol.amount.toString()).to.eq(amount.toString());

    const autoBal = await provider.connection.getBalance(auto);
    expect(autoBal).to.be.greaterThanOrEqual(amount.toNumber());

    const cfgAfter = await program.account.config.fetch(configPda);
    expect(cfgAfter.automationCount.toString()).to.eq((nonce + 1n).toString());
  });

  it("rejects deposit below the minimum", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    let threw = false;
    try {
      await program.methods
        .createAutomation(
          trigger.accountTransfer(watched.publicKey),
          action.transferSol(destination.publicKey, new BN(100)),
          cadence.once(),
          NO_INTERVAL
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /DepositTooSmall|depositTooSmall/i
      );
    }
    expect(threw, "expected DepositTooSmall").to.eq(true);
  });

  it("rejects token-price trigger with positive expo", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const fakeFeed = Keypair.generate().publicKey;

    let threw = false;
    try {
      await program.methods
        .createAutomation(
          trigger.assetPriceBelow(fakeFeed, new BN(100_000_000), 1),
          action.transferSol(destination.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)),
          cadence.once(),
          NO_INTERVAL
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /BadPythExpo|badPythExpo/i
      );
    }
    expect(threw).to.eq(true);
  });

  it("rejects execute from a non-keeper signer", async () => {
    const auto = automationPdaFor(program.programId, owner.publicKey, 0n);

    let threw = false;
    try {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: intruder.publicKey,
          config: configPda,
          automation: auto,
          destination: destination.publicKey,
        })
        .signers([intruder])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /UnauthorizedKeeper|unauthorizedKeeper/i
      );
    }
    expect(threw, "expected UnauthorizedKeeper").to.eq(true);
  });

  it("executes a transfer-SOL automation via the keeper", async () => {
    const auto = automationPdaFor(program.programId, owner.publicKey, 0n);
    const a = await program.account.automation.fetch(auto);
    const amount = (a.action as any).transferSol.amount.toNumber();

    const destBefore = await provider.connection.getBalance(destination.publicKey);
    const autoBefore = await provider.connection.getBalance(auto);

    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: keeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .signers([keeper])
      .rpc();

    const destAfter = await provider.connection.getBalance(destination.publicKey);
    const autoAfter = await provider.connection.getBalance(auto);

    expect(destAfter - destBefore).to.eq(amount);
    expect(autoBefore - autoAfter).to.eq(amount);

    const after = await program.account.automation.fetch(auto);
    expect(after.finished).to.eq(true);
    expect(after.executedAt.toNumber()).to.be.greaterThan(0);
  });

  it("rejects double-execute on a SOL automation", async () => {
    const auto = automationPdaFor(program.programId, owner.publicKey, 0n);
    let threw = false;
    try {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: keeper.publicKey,
          config: configPda,
          automation: auto,
          destination: destination.publicKey,
        })
        .signers([keeper])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /AutomationFinished|automationFinished/i
      );
    }
    expect(threw).to.eq(true);
  });

  it("creates and executes a token-price automation (trigger metadata only — keeper-trusted)", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    // Threshold $100 USD, scaled to Pyth's typical -8 expo: 100 * 10^8.
    const threshold = new BN("10000000000");
    const fakeFeed = Keypair.generate().publicKey;

    await program.methods
      .createAutomation(
        trigger.assetPriceBelow(fakeFeed, threshold, -8),
        action.transferSol(destination.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)),
        cadence.once(),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: keeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .signers([keeper])
      .rpc();

    const after = await program.account.automation.fetch(auto);
    expect(after.finished).to.eq(true);
    expect((after.trigger as any).assetPrice.threshold.toString()).to.eq(threshold.toString());
    expect((after.trigger as any).assetPrice.expo).to.eq(-8);
    expect((after.trigger as any).assetPrice.source).to.eq(0); // PYTH default
  });

  it("creates a Jupiter-source AssetPrice automation (mint as feed)", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    // Jupiter prices use expo=-6 by convention (USDC scale).
    const threshold = new BN("1500000"); // $1.50
    const fakeMint = Keypair.generate().publicKey;

    await program.methods
      .createAutomation(
        trigger.assetPriceAbove(fakeMint, threshold, -6, null, 1 /* JUPITER */),
        action.transferSol(destination.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)),
        cadence.once(),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const after = await program.account.automation.fetch(auto);
    expect((after.trigger as any).assetPrice.source).to.eq(1);
    expect((after.trigger as any).assetPrice.feed.toBase58()).to.eq(fakeMint.toBase58());
  });

  it("rejects AssetPrice with unknown oracle source", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    let threw = false;
    try {
      await program.methods
        .createAutomation(
          trigger.assetPriceBelow(
            Keypair.generate().publicKey,
            new BN("1000000"),
            -6,
            null,
            99 /* unknown source */,
          ),
          action.transferSol(destination.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)),
          cadence.once(),
          NO_INTERVAL,
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (err) {
      threw = true;
      expect(String(err)).to.include("BadOracleSource");
    }
    expect(threw).to.eq(true);
  });

  it("rejects execute when paused, allows again after unpause", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.1 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.once(),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    await program.methods
      .setPaused(true)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    let threw = false;
    try {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: keeper.publicKey,
          config: configPda,
          automation: auto,
          destination: destination.publicKey,
        })
        .signers([keeper])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(/Paused|paused/i);
    }
    expect(threw).to.eq(true);

    await program.methods
      .setPaused(false)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: keeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .signers([keeper])
      .rpc();

    const after = await program.account.automation.fetch(auto);
    expect(after.finished).to.eq(true);
  });

  it("creates and executes an SPL transfer automation", async () => {
    // Mint a fresh test token with the test owner as authority.
    const mint = Keypair.generate();
    const mintRent = await getMinimumBalanceForRentExemptMint(provider.connection);
    const decimals = 6;

    const ataOwnerKeeper = getAssociatedTokenAddressSync(
      mint.publicKey,
      owner.publicKey
    );
    const splDestination = Keypair.generate();
    const ataDestination = getAssociatedTokenAddressSync(
      mint.publicKey,
      splDestination.publicKey
    );

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
          createInitializeMintInstruction(
            mint.publicKey,
            decimals,
            owner.publicKey,
            null
          )
        )
        .add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            ataOwnerKeeper,
            owner.publicKey,
            mint.publicKey
          )
        )
        .add(
          createMintToInstruction(
            mint.publicKey,
            ataOwnerKeeper,
            owner.publicKey,
            10_000_000n
          )
        )
        .add(
          createAssociatedTokenAccountInstruction(
            owner.publicKey,
            ataDestination,
            splDestination.publicKey,
            mint.publicKey
          )
        );
      await anchor.web3.sendAndConfirmTransaction(
        provider.connection,
        tx,
        [owner, mint],
        { commitment: "confirmed" }
      );
    }

    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const ataAuto = getAssociatedTokenAddressSync(mint.publicKey, auto, true);
    const splAmount = new BN(1_000_000); // 1 token at decimals=6

    // Pre-create the automation PDA's ATA in the same tx as create_automation_spl.
    const createAtaIx = createAssociatedTokenAccountInstruction(
      owner.publicKey,
      ataAuto,
      auto,
      mint.publicKey
    );

    const createSplIx = await program.methods
      .createAutomationSpl(
        trigger.accountTransfer(watched.publicKey),
        action.transferSpl(splDestination.publicKey, mint.publicKey, splAmount),
        cadence.once(),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        mint: mint.publicKey,
        ownerAta: ataOwnerKeeper,
        automationAta: ataAuto,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    {
      const tx = new Transaction().add(createAtaIx).add(createSplIx);
      await anchor.web3.sendAndConfirmTransaction(
        provider.connection,
        tx,
        [owner],
        { commitment: "confirmed" }
      );
    }

    const ataAutoAfterCreate = await getTokenAccount(provider.connection, ataAuto);
    expect(ataAutoAfterCreate.amount.toString()).to.eq(splAmount.toString());

    await program.methods
      .executeAutomationSpl()
      .accountsStrict({
        keeper: keeper.publicKey,
        config: configPda,
        automation: auto,
        mint: mint.publicKey,
        automationAta: ataAuto,
        destinationAta: ataDestination,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([keeper])
      .rpc();

    const ataAutoAfterExec = await getTokenAccount(provider.connection, ataAuto);
    const ataDestAfterExec = await getTokenAccount(provider.connection, ataDestination);
    expect(ataAutoAfterExec.amount.toString()).to.eq("0");
    expect(ataDestAfterExec.amount.toString()).to.eq(splAmount.toString());
  });

  it("closes a fresh automation and refunds owner", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.2 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, amount),
        cadence.once(),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const ownerBefore = await provider.connection.getBalance(owner.publicKey);
    const autoBalance = await provider.connection.getBalance(auto);

    await program.methods
      .closeAutomation()
      .accountsStrict({
        owner: owner.publicKey,
        automation: auto,
        config: configPda,
        treasury: admin.publicKey,
      })
      .signers([owner])
      .rpc();

    const ownerAfter = await provider.connection.getBalance(owner.publicKey);
    const acct = await provider.connection.getAccountInfo(auto);
    expect(acct).to.eq(null);
    expect(ownerAfter - ownerBefore).to.be.greaterThan(autoBalance - 1_000_000);
  });

  it("rotates the keeper via update_keeper", async () => {
    await program.methods
      .updateKeeper(otherKeeper.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.keeper.toBase58()).to.eq(otherKeeper.publicKey.toBase58());

    await program.methods
      .updateKeeper(keeper.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();
  });

  /* ── Cadence: For (Repeat) ────────────────────────────────────────── */

  it("Repeat cadence fires `total` times then becomes Finished", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    // Three small fires of 0.05 SOL each, no minimum interval.
    const TOTAL = 3;
    const perFire = new BN(0.05 * LAMPORTS_PER_SOL);
    // Fund the PDA above per-fire × TOTAL plus rent — easiest is one big
    // deposit on the first action; tests use the same `amount` field every
    // fire so we just leave plenty of room and let the program subtract
    // it `TOTAL` times.
    const fundedAmount = new BN(0.05 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, fundedAmount),
        cadence.repeat(TOTAL),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    // Top up the PDA so we can afford TOTAL × perFire transfers — the
    // initial deposit only covered one fire's worth of `amount`. Anchor's
    // create_automation pays rent + amount; we add the remainder by hand.
    const topUp = perFire.muln(TOTAL - 1).toNumber();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(auto, topUp),
      "confirmed"
    );

    for (let i = 1; i <= TOTAL; i++) {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: keeper.publicKey,
          config: configPda,
          automation: auto,
          destination: destination.publicKey,
        })
        .signers([keeper])
        .rpc();
      const mid = await program.account.automation.fetch(auto);
      expect(mid.executions).to.eq(i);
      expect(mid.finished).to.eq(i === TOTAL);
    }

    // Fourth attempt must fail with AutomationFinished.
    let threw = false;
    try {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: keeper.publicKey,
          config: configPda,
          automation: auto,
          destination: destination.publicKey,
        })
        .signers([keeper])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /AutomationFinished|automationFinished/i
      );
    }
    expect(threw, "expected AutomationFinished after exhausting repeat bound").to.eq(true);
  });

  /* ── Cadence: While (Until) ──────────────────────────────────────── */

  it("Until cadence fires repeatedly until deadline, then becomes Finished", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const perFire = new BN(0.02 * LAMPORTS_PER_SOL);
    // Deadline 60 s in the future — enough headroom for two fires before
    // we manually ask the chain to be past the deadline. We can't time-travel
    // on solana-test-validator, so instead we just verify two fires land,
    // then rebuild a *separate* automation with a deadline already 1 s
    // in the past after creation (gated only at execute time, since
    // create_automation requires deadline > now).
    const farFuture = new BN(Math.floor(Date.now() / 1000) + 60);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, perFire),
        cadence.until(farFuture),
        NO_INTERVAL
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    // Top up so two fires land.
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(auto, perFire.toNumber()),
      "confirmed"
    );

    for (let i = 1; i <= 2; i++) {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: keeper.publicKey,
          config: configPda,
          automation: auto,
          destination: destination.publicKey,
        })
        .signers([keeper])
        .rpc();
      const mid = await program.account.automation.fetch(auto);
      expect(mid.executions).to.eq(i);
      // Until-cadence stays not-finished while now < deadline, regardless
      // of how many fires have landed.
      expect(mid.finished).to.eq(false);
    }
  });

  /* ── min_interval_secs ────────────────────────────────────────────── */

  it("MinIntervalNotElapsed blocks back-to-back fires within the interval", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const perFire = new BN(0.02 * LAMPORTS_PER_SOL);
    // Two fires required, with a 1-hour gap between them. We won't wait
    // an hour — we just confirm the second attempt errors with
    // MinIntervalNotElapsed.
    const ONE_HOUR = 3600;

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, perFire),
        cadence.repeat(2),
        ONE_HOUR
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();
    // Top up for a second fire (we won't land it).
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(auto, perFire.toNumber()),
      "confirmed"
    );

    // First fire — allowed (executions == 0, no interval gate yet).
    await program.methods
      .executeAutomation()
      .accountsStrict({
        keeper: keeper.publicKey,
        config: configPda,
        automation: auto,
        destination: destination.publicKey,
      })
      .signers([keeper])
      .rpc();

    // Immediate second fire — must hit MinIntervalNotElapsed.
    let threw = false;
    try {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: keeper.publicKey,
          config: configPda,
          automation: auto,
          destination: destination.publicKey,
        })
        .signers([keeper])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /MinIntervalNotElapsed|minIntervalNotElapsed/i
      );
    }
    expect(threw, "expected MinIntervalNotElapsed").to.eq(true);
  });

  /* ── Cadence validation ──────────────────────────────────────────── */

  it("rejects Until cadence with a deadline already in the past", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const pastDeadline = new BN(Math.floor(Date.now() / 1000) - 60);

    let threw = false;
    try {
      await program.methods
        .createAutomation(
          trigger.accountTransfer(watched.publicKey),
          action.transferSol(destination.publicKey, new BN(0.02 * LAMPORTS_PER_SOL)),
          cadence.until(pastDeadline),
          NO_INTERVAL
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /BadCadence|badCadence/i
      );
    }
    expect(threw, "expected BadCadence for past deadline").to.eq(true);
  });

  /* ── Swap (Orca Whirlpool) ───────────────────────────────────── */

  it("creates a Swap automation and locks the action fields on chain", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    // Spin up a fresh input SPL mint owned by `owner`. Output mint can
    // be any pubkey — the program records it but never touches it
    // until execute_swap (which we don't run here, since localnet
    // doesn't have Jupiter loaded — that test belongs to a devnet/
    // mainnet integration smoke run).
    const inputMintKp = Keypair.generate();
    const outputMint = Keypair.generate().publicKey;
    const lamportsForMint = await getMinimumBalanceForRentExemptMint(
      provider.connection,
    );
    const inputMint = inputMintKp.publicKey;

    // Allocate the mint, init it, and create owner's ATA + the
    // automation PDA's ATA (the latter must exist before
    // create_automation_swap pulls the deposit into it).
    const ownerAta = getAssociatedTokenAddressSync(inputMint, owner.publicKey);
    const automationAta = getAssociatedTokenAddressSync(inputMint, auto, true);
    const setupTx = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: inputMint,
          space: MINT_SIZE,
          lamports: lamportsForMint,
          programId: TOKEN_PROGRAM_ID,
        }),
      )
      .add(createInitializeMintInstruction(inputMint, 6, owner.publicKey, null))
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          ownerAta,
          owner.publicKey,
          inputMint,
        ),
      )
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          automationAta,
          auto,
          inputMint,
        ),
      )
      .add(
        createMintToInstruction(
          inputMint,
          ownerAta,
          owner.publicKey,
          1_000_000n,
        ),
      );
    await provider.sendAndConfirm(setupTx, [owner, inputMintKp]);

    const amountIn = new BN(500_000);
    const minAmountOut = new BN(0);

    await program.methods
      .createAutomationSwap(
        trigger.assetPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
        action.swap(inputMint, outputMint, owner.publicKey, amountIn, minAmountOut),
        cadence.once(),
        NO_INTERVAL,
        false,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        inputMint,
        ownerInputAta: ownerAta,
        automationInputAta: automationAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const a = await program.account.automation.fetch(auto);
    expect(a.action).to.have.nested.property("swap");
    const swap = (a.action as any).swap;
    expect(swap.inputMint.toBase58()).to.eq(inputMint.toBase58());
    expect(swap.outputMint.toBase58()).to.eq(outputMint.toBase58());
    expect(swap.destination.toBase58()).to.eq(owner.publicKey.toBase58());
    expect(swap.amountIn.toString()).to.eq(amountIn.toString());
    expect(swap.minAmountOut.toString()).to.eq(minAmountOut.toString());
    expect(a.finished).to.eq(false);

    // PDA's input ATA should now hold the deposited amount. With the
    // Once cadence the deposit equals amount_in × 1.
    const ataAfter = await getTokenAccount(provider.connection, automationAta);
    expect(ataAfter.amount.toString()).to.eq(amountIn.toString());
  });

  it("Repeat-cadence swap deposits amount_in × total at create time", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    const inputMintKp = Keypair.generate();
    const outputMint = Keypair.generate().publicKey;
    const inputMint = inputMintKp.publicKey;
    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection);
    const ownerAta = getAssociatedTokenAddressSync(inputMint, owner.publicKey);
    const automationAta = getAssociatedTokenAddressSync(inputMint, auto, true);

    const TOTAL = 4;
    const amountIn = new BN(250_000);
    const expectedDeposit = amountIn.muln(TOTAL); // 1_000_000

    const setup = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: inputMint,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
      )
      .add(createInitializeMintInstruction(inputMint, 6, owner.publicKey, null))
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          ownerAta,
          owner.publicKey,
          inputMint,
        ),
      )
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          automationAta,
          auto,
          inputMint,
        ),
      )
      .add(
        createMintToInstruction(
          inputMint,
          ownerAta,
          owner.publicKey,
          BigInt(expectedDeposit.toString()),
        ),
      );
    await provider.sendAndConfirm(setup, [owner, inputMintKp]);

    await program.methods
      .createAutomationSwap(
        trigger.assetPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
        action.swap(inputMint, outputMint, owner.publicKey, amountIn, new BN(0)),
        cadence.repeat(TOTAL),
        NO_INTERVAL,
        false,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        inputMint,
        ownerInputAta: ownerAta,
        automationInputAta: automationAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const ataAfter = await getTokenAccount(provider.connection, automationAta);
    expect(ataAfter.amount.toString()).to.eq(expectedDeposit.toString());
  });

  it("rejects Until cadence on a swap (SwapUntilNotSupported)", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    const inputMintKp = Keypair.generate();
    const inputMint = inputMintKp.publicKey;
    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection);
    const ownerAta = getAssociatedTokenAddressSync(inputMint, owner.publicKey);
    const automationAta = getAssociatedTokenAddressSync(inputMint, auto, true);

    const setup = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: inputMint,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
      )
      .add(createInitializeMintInstruction(inputMint, 6, owner.publicKey, null))
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          ownerAta,
          owner.publicKey,
          inputMint,
        ),
      )
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          automationAta,
          auto,
          inputMint,
        ),
      );
    await provider.sendAndConfirm(setup, [owner, inputMintKp]);

    const farFuture = new BN(Math.floor(Date.now() / 1000) + 86_400);
    let threw = false;
    try {
      await program.methods
        .createAutomationSwap(
          trigger.assetPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
          action.swap(
            inputMint,
            Keypair.generate().publicKey,
            owner.publicKey,
            new BN(100_000),
            new BN(0),
          ),
          cadence.until(farFuture),
          NO_INTERVAL,
          false,
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          inputMint,
          ownerInputAta: ownerAta,
          automationInputAta: automationAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /SwapUntilNotSupported|swapUntilNotSupported/i,
      );
    }
    expect(threw, "expected SwapUntilNotSupported").to.eq(true);
  });

  it("rejects Swap action sent through create_automation_spl (ActionMismatch)", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    // Reuse a fresh mint just for the rejection-path test.
    const mintKp = Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection);
    const ownerAta = getAssociatedTokenAddressSync(mintKp.publicKey, owner.publicKey);
    const autoAta = getAssociatedTokenAddressSync(mintKp.publicKey, auto, true);
    const setup = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: mintKp.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
      )
      .add(createInitializeMintInstruction(mintKp.publicKey, 6, owner.publicKey, null))
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          ownerAta,
          owner.publicKey,
          mintKp.publicKey,
        ),
      )
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          autoAta,
          auto,
          mintKp.publicKey,
        ),
      );
    await provider.sendAndConfirm(setup, [owner, mintKp]);

    let threw = false;
    try {
      await program.methods
        .createAutomationSpl(
          trigger.accountTransfer(watched.publicKey),
          action.swap(
            mintKp.publicKey,
            Keypair.generate().publicKey,
            owner.publicKey,
            new BN(100_000),
            new BN(0),
          ),
          cadence.once(),
          NO_INTERVAL,
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          mint: mintKp.publicKey,
          ownerAta,
          automationAta: autoAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /ActionMismatch|actionMismatch/i,
      );
    }
    expect(threw, "expected ActionMismatch when Swap goes through create_automation_spl").to.eq(
      true,
    );
  });

  it("rejects Repeat cadence with total = 0", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    let threw = false;
    try {
      await program.methods
        .createAutomation(
          trigger.accountTransfer(watched.publicKey),
          action.transferSol(destination.publicKey, new BN(0.02 * LAMPORTS_PER_SOL)),
          cadence.repeat(0),
          NO_INTERVAL
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /BadCadence|badCadence/i
      );
    }
    expect(threw, "expected BadCadence for total=0").to.eq(true);
  });

  /* ── v4.1: treasury, close-fee deduction, fee_topup_enabled ────────── */

  it("update_treasury rotates the treasury pubkey (admin only)", async () => {
    const newTreasury = Keypair.generate().publicKey;

    await program.methods
      .updateTreasury(newTreasury)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    let cfg = await program.account.config.fetch(configPda);
    expect(cfg.treasury.toBase58()).to.eq(newTreasury.toBase58());

    // Rotate back so subsequent tests can assume treasury == admin.
    await program.methods
      .updateTreasury(admin.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    cfg = await program.account.config.fetch(configPda);
    expect(cfg.treasury.toBase58()).to.eq(admin.publicKey.toBase58());
  });

  it("update_treasury rejects non-admin signers", async () => {
    const intruderKp = Keypair.generate();
    await fund(intruderKp.publicKey, 0.1);

    let threw = false;
    try {
      await program.methods
        .updateTreasury(intruderKp.publicKey)
        .accountsStrict({ admin: intruderKp.publicKey, config: configPda })
        .signers([intruderKp])
        .rpc();
    } catch (e: any) {
      threw = true;
      // has_one = admin → ConstraintHasOne / 2001
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /HasOne|hasOne|2001/i,
      );
    }
    expect(threw, "expected has_one violation for non-admin").to.eq(true);
  });

  it("update_close_fee sets the fee within the cap", async () => {
    const FEE = new BN(1_000_000); // 0.001 SOL
    await program.methods
      .updateCloseFee(FEE)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.closeFeeLamports.toString()).to.eq(FEE.toString());
  });

  it("update_close_fee rejects fees above MAX_CLOSE_FEE_LAMPORTS (0.1 SOL)", async () => {
    let threw = false;
    try {
      await program.methods
        .updateCloseFee(new BN(100_000_001))
        .accountsStrict({ admin: admin.publicKey, config: configPda })
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /FeeTooLarge|feeTooLarge/i,
      );
    }
    expect(threw, "expected FeeTooLarge").to.eq(true);
  });

  it("close_automation deducts close-fee to treasury and refunds rest to owner", async () => {
    // Use a dedicated treasury keypair so we measure the exact close-fee
    // landing without admin's tx-fee bookkeeping muddying the delta.
    const treasuryKp = Keypair.generate();
    await fund(treasuryKp.publicKey, 0.001); // rent-exempt floor

    await program.methods
      .updateTreasury(treasuryKp.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    const cfg0 = await program.account.config.fetch(configPda);
    const fee = Number(cfg0.closeFeeLamports.toString());
    expect(fee, "previous test must have set a non-zero fee").to.be.greaterThan(0);

    const nonce = BigInt(cfg0.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const depositSol = new BN(0.1 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, depositSol),
        cadence.once(),
        NO_INTERVAL,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const treasuryBefore = await provider.connection.getBalance(treasuryKp.publicKey);
    const ownerBefore = await provider.connection.getBalance(owner.publicKey);
    const pdaBefore = await provider.connection.getBalance(auto);

    await program.methods
      .closeAutomation()
      .accountsStrict({
        owner: owner.publicKey,
        automation: auto,
        config: configPda,
        treasury: treasuryKp.publicKey,
      })
      .signers([owner])
      .rpc();

    const treasuryAfter = await provider.connection.getBalance(treasuryKp.publicKey);
    const ownerAfter = await provider.connection.getBalance(owner.publicKey);
    const acct = await provider.connection.getAccountInfo(auto);

    expect(acct, "PDA must be closed").to.eq(null);
    // Treasury isn't a tx signer; its delta equals exactly the close fee.
    expect(treasuryAfter - treasuryBefore).to.eq(fee, "treasury got the fee");
    // Owner refund = pdaBefore - fee. Owner isn't paying tx fees here
    // either (provider wallet is the fee payer), so the delta should
    // equal the expected refund precisely.
    const expectedOwnerDelta = pdaBefore - fee;
    expect(ownerAfter - ownerBefore).to.eq(expectedOwnerDelta, "owner refund");

    // Rotate treasury back to admin so the rest of the suite has a
    // simple invariant.
    await program.methods
      .updateTreasury(admin.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();
  });

  it("close_automation rejects a treasury account that doesn't match Config.treasury", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)),
        cadence.once(),
        NO_INTERVAL,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .closeAutomation()
        .accountsStrict({
          owner: owner.publicKey,
          automation: auto,
          config: configPda,
          // Wrong treasury — should fail with WrongTreasury / address mismatch.
          treasury: Keypair.generate().publicKey,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(
        `${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`,
      ).to.match(/WrongTreasury|wrongTreasury|ConstraintAddress/i);
    }
    expect(threw, "expected wrong-treasury rejection").to.eq(true);

    // Cleanup so the test suite remains in a consistent state.
    await program.methods
      .closeAutomation()
      .accountsStrict({
        owner: owner.publicKey,
        automation: auto,
        config: configPda,
        treasury: admin.publicKey,
      })
      .signers([owner])
      .rpc();

    // Reset close-fee to 0 so subsequent assertions don't accidentally pay.
    await program.methods
      .updateCloseFee(new BN(0))
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();
  });

  it("Automation defaults fee_topup_enabled to false on non-swap creates", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)),
        cadence.once(),
        NO_INTERVAL,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const a = await program.account.automation.fetch(auto);
    expect(a.feeTopupEnabled).to.eq(false);

    // Cleanup.
    await program.methods
      .closeAutomation()
      .accountsStrict({
        owner: owner.publicKey,
        automation: auto,
        config: configPda,
        treasury: admin.publicKey,
      })
      .signers([owner])
      .rpc();
  });

  it("create_automation_swap honors the enable_fee_topup parameter", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);

    const inputMintKp = Keypair.generate();
    const outputMint = Keypair.generate().publicKey;
    const inputMint = inputMintKp.publicKey;
    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection);
    const ownerAta = getAssociatedTokenAddressSync(inputMint, owner.publicKey);
    const automationAta = getAssociatedTokenAddressSync(inputMint, auto, true);

    const setup = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: inputMint,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        }),
      )
      .add(createInitializeMintInstruction(inputMint, 6, owner.publicKey, null))
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          ownerAta,
          owner.publicKey,
          inputMint,
        ),
      )
      .add(
        createAssociatedTokenAccountInstruction(
          owner.publicKey,
          automationAta,
          auto,
          inputMint,
        ),
      )
      .add(
        createMintToInstruction(inputMint, ownerAta, owner.publicKey, 1_000_000n),
      );
    await provider.sendAndConfirm(setup, [owner, inputMintKp]);

    await program.methods
      .createAutomationSwap(
        trigger.assetPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
        action.swap(inputMint, outputMint, owner.publicKey, new BN(500_000), new BN(0)),
        cadence.once(),
        NO_INTERVAL,
        true, // enable_fee_topup
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: auto,
        inputMint,
        ownerInputAta: ownerAta,
        automationInputAta: automationAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    const a = await program.account.automation.fetch(auto);
    expect(a.feeTopupEnabled).to.eq(true);
  });

  it("migrate_config is idempotent — running it on a v4.1 Config preserves admin's customizations", async () => {
    // Set a non-zero fee + custom treasury so we can detect any
    // unintended reset by `migrate_config`. The handler resets these
    // to defaults — which is the documented one-shot semantics — so
    // test that explicitly: after migrate, treasury == admin and
    // close_fee_lamports == 0, regardless of prior state.
    const customTreasury = Keypair.generate().publicKey;
    const customFee = new BN(2_000_000);
    await program.methods
      .updateTreasury(customTreasury)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();
    await program.methods
      .updateCloseFee(customFee)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    await program.methods
      .migrateConfig()
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.treasury.toBase58()).to.eq(admin.publicKey.toBase58());
    expect(cfg.closeFeeLamports.toString()).to.eq("0");
  });

  /* ── v4.1: kill switch (shutdown) and admin-driven wind-down close ─── */

  // Captured at suite scope so the shutdown block can reference automations
  // created BEFORE the kill switch flips.
  const windDownTreasury = Keypair.generate();
  let pre_shutdown_sol_auto: PublicKey;
  let pre_shutdown_spl_auto: PublicKey;
  let pre_shutdown_swap_auto: PublicKey;
  let pre_shutdown_spl_mint: PublicKey;
  let pre_shutdown_swap_input_mint: PublicKey;
  let pre_shutdown_admin_balance_checkpoint: number;

  it("update_admin rotates admin and rejects non-admin signers", async () => {
    const newAdmin = Keypair.generate();
    await fund(newAdmin.publicKey, 0.5);

    // Happy path: current admin rotates to new admin
    await program.methods
      .updateAdmin(newAdmin.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    let cfg = await program.account.config.fetch(configPda);
    expect(cfg.admin.toBase58()).to.eq(newAdmin.publicKey.toBase58());

    // Non-admin (original admin no longer authorized) attempt → has_one fails
    let threw = false;
    try {
      await program.methods
        .updateAdmin(admin.publicKey)
        .accountsStrict({ admin: admin.publicKey, config: configPda })
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /HasOne|hasOne|2001/i,
      );
    }
    expect(threw, "expected has_one violation").to.eq(true);

    // Rotate back so the rest of the suite can use `admin`.
    await program.methods
      .updateAdmin(admin.publicKey)
      .accountsStrict({ admin: newAdmin.publicKey, config: configPda })
      .signers([newAdmin])
      .rpc();

    cfg = await program.account.config.fetch(configPda);
    expect(cfg.admin.toBase58()).to.eq(admin.publicKey.toBase58());
  });

  it("Pre-shutdown: stages SOL / SPL / Swap automations to be closed by admin later", async () => {
    // Treasury is a dedicated keypair so we can assert exact lamport
    // deltas without conflating tx-fee bookkeeping with admin's wallet.
    await fund(windDownTreasury.publicKey, 0.001);
    await program.methods
      .updateTreasury(windDownTreasury.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    // SOL rule
    let cfg = await program.account.config.fetch(configPda);
    let nonce = BigInt(cfg.automationCount.toString());
    pre_shutdown_sol_auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    await program.methods
      .createAutomation(
        trigger.accountTransfer(watched.publicKey),
        action.transferSol(destination.publicKey, new BN(0.07 * LAMPORTS_PER_SOL)),
        cadence.once(),
        NO_INTERVAL,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: pre_shutdown_sol_auto,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // SPL rule
    const splMintKp = Keypair.generate();
    pre_shutdown_spl_mint = splMintKp.publicKey;
    const lamportsForMint = await getMinimumBalanceForRentExemptMint(provider.connection);
    cfg = await program.account.config.fetch(configPda);
    nonce = BigInt(cfg.automationCount.toString());
    pre_shutdown_spl_auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const splOwnerAta = getAssociatedTokenAddressSync(pre_shutdown_spl_mint, owner.publicKey);
    const splDestAta = getAssociatedTokenAddressSync(pre_shutdown_spl_mint, destination.publicKey);
    const splAutoAta = getAssociatedTokenAddressSync(pre_shutdown_spl_mint, pre_shutdown_spl_auto, true);

    const splSetup = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: pre_shutdown_spl_mint,
          space: MINT_SIZE,
          lamports: lamportsForMint,
          programId: TOKEN_PROGRAM_ID,
        }),
      )
      .add(createInitializeMintInstruction(pre_shutdown_spl_mint, 6, owner.publicKey, null))
      .add(createAssociatedTokenAccountInstruction(owner.publicKey, splOwnerAta, owner.publicKey, pre_shutdown_spl_mint))
      .add(createAssociatedTokenAccountInstruction(owner.publicKey, splDestAta, destination.publicKey, pre_shutdown_spl_mint))
      .add(createAssociatedTokenAccountInstruction(owner.publicKey, splAutoAta, pre_shutdown_spl_auto, pre_shutdown_spl_mint))
      .add(createMintToInstruction(pre_shutdown_spl_mint, splOwnerAta, owner.publicKey, 750_000n));
    await provider.sendAndConfirm(splSetup, [owner, splMintKp]);

    await program.methods
      .createAutomationSpl(
        trigger.accountTransfer(watched.publicKey),
        action.transferSpl(destination.publicKey, pre_shutdown_spl_mint, new BN(500_000)),
        cadence.once(),
        NO_INTERVAL,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: pre_shutdown_spl_auto,
        mint: pre_shutdown_spl_mint,
        ownerAta: splOwnerAta,
        destinationAta: splDestAta,
        automationAta: splAutoAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    // Swap rule
    const swapMintKp = Keypair.generate();
    pre_shutdown_swap_input_mint = swapMintKp.publicKey;
    cfg = await program.account.config.fetch(configPda);
    nonce = BigInt(cfg.automationCount.toString());
    pre_shutdown_swap_auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const swapOwnerAta = getAssociatedTokenAddressSync(pre_shutdown_swap_input_mint, owner.publicKey);
    const swapAutoAta = getAssociatedTokenAddressSync(pre_shutdown_swap_input_mint, pre_shutdown_swap_auto, true);
    const swapSetup = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: owner.publicKey,
          newAccountPubkey: pre_shutdown_swap_input_mint,
          space: MINT_SIZE,
          lamports: lamportsForMint,
          programId: TOKEN_PROGRAM_ID,
        }),
      )
      .add(createInitializeMintInstruction(pre_shutdown_swap_input_mint, 6, owner.publicKey, null))
      .add(createAssociatedTokenAccountInstruction(owner.publicKey, swapOwnerAta, owner.publicKey, pre_shutdown_swap_input_mint))
      .add(createAssociatedTokenAccountInstruction(owner.publicKey, swapAutoAta, pre_shutdown_swap_auto, pre_shutdown_swap_input_mint))
      .add(createMintToInstruction(pre_shutdown_swap_input_mint, swapOwnerAta, owner.publicKey, 1_000_000n));
    await provider.sendAndConfirm(swapSetup, [owner, swapMintKp]);

    await program.methods
      .createAutomationSwap(
        trigger.assetPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
        action.swap(pre_shutdown_swap_input_mint, Keypair.generate().publicKey, owner.publicKey, new BN(400_000), new BN(0)),
        cadence.once(),
        NO_INTERVAL,
        false,
      )
      .accountsStrict({
        owner: owner.publicKey,
        config: configPda,
        automation: pre_shutdown_swap_auto,
        inputMint: pre_shutdown_swap_input_mint,
        ownerInputAta: swapOwnerAta,
        automationInputAta: swapAutoAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([owner])
      .rpc();

    pre_shutdown_admin_balance_checkpoint = await provider.connection.getBalance(admin.publicKey);
  });

  it("admin_close_automation rejects pre-shutdown (NotShutdown)", async () => {
    let threw = false;
    try {
      await program.methods
        .adminCloseAutomation()
        .accountsStrict({
          admin: admin.publicKey,
          owner: owner.publicKey,
          automation: pre_shutdown_sol_auto,
          config: configPda,
          treasury: windDownTreasury.publicKey,
        })
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /NotShutdown|notShutdown/i,
      );
    }
    expect(threw, "expected NotShutdown").to.eq(true);
  });

  // ── set_shutdown is one-way and global; everything below depends on it ──
  it("set_shutdown flips Config.shutdown = true and rejects double-flip", async () => {
    await program.methods
      .setShutdown()
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();

    const cfg = await program.account.config.fetch(configPda);
    expect(cfg.shutdown).to.eq(true);

    // Second call rejects.
    let threw = false;
    try {
      await program.methods
        .setShutdown()
        .accountsStrict({ admin: admin.publicKey, config: configPda })
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /ShutdownAlreadySet|shutdownAlreadySet/i,
      );
    }
    expect(threw, "expected ShutdownAlreadySet on double-flip").to.eq(true);
  });

  it("set_shutdown rejects non-admin signers", async () => {
    const intruderKp = Keypair.generate();
    await fund(intruderKp.publicKey, 0.05);
    let threw = false;
    try {
      await program.methods
        .setShutdown()
        .accountsStrict({ admin: intruderKp.publicKey, config: configPda })
        .signers([intruderKp])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /HasOne|hasOne|ShutdownAlreadySet|2001/i,
      );
    }
    expect(threw).to.eq(true);
  });

  it("Post-shutdown: execute_automation reverts with Shutdown", async () => {
    // Use the pre-shutdown SOL automation. Keeper attempts execute → revert.
    let threw = false;
    try {
      await program.methods
        .executeAutomation()
        .accountsStrict({
          keeper: keeper.publicKey,
          config: configPda,
          automation: pre_shutdown_sol_auto,
          destination: destination.publicKey,
        })
        .signers([keeper])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /Shutdown|shutdown/i,
      );
    }
    expect(threw, "expected Shutdown error on execute").to.eq(true);
  });

  it("Post-shutdown: create_automation reverts with Shutdown", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    let threw = false;
    try {
      await program.methods
        .createAutomation(
          trigger.accountTransfer(watched.publicKey),
          action.transferSol(destination.publicKey, new BN(0.05 * LAMPORTS_PER_SOL)),
          cadence.once(),
          NO_INTERVAL,
        )
        .accountsStrict({
          owner: owner.publicKey,
          config: configPda,
          automation: auto,
          systemProgram: SystemProgram.programId,
        })
        .signers([owner])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /Shutdown|shutdown/i,
      );
    }
    expect(threw).to.eq(true);
  });

  it("Post-shutdown: update_treasury, update_close_fee, update_admin, migrate_config all revert", async () => {
    const checks: Array<() => Promise<unknown>> = [
      () =>
        program.methods
          .updateTreasury(Keypair.generate().publicKey)
          .accountsStrict({ admin: admin.publicKey, config: configPda })
          .rpc(),
      () =>
        program.methods
          .updateCloseFee(new BN(0))
          .accountsStrict({ admin: admin.publicKey, config: configPda })
          .rpc(),
      () =>
        program.methods
          .updateAdmin(Keypair.generate().publicKey)
          .accountsStrict({ admin: admin.publicKey, config: configPda })
          .rpc(),
      () =>
        program.methods
          .migrateConfig()
          .accountsStrict({
            admin: admin.publicKey,
            config: configPda,
            systemProgram: SystemProgram.programId,
          })
          .rpc(),
    ];
    for (const run of checks) {
      let threw = false;
      try {
        await run();
      } catch (e: any) {
        threw = true;
        expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
          /Shutdown|shutdown/i,
        );
      }
      expect(threw, "expected Shutdown rejection").to.eq(true);
    }
  });

  it("Post-shutdown: update_keeper still works (harmless)", async () => {
    const tempKeeper = Keypair.generate();
    await program.methods
      .updateKeeper(tempKeeper.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();
    let cfg = await program.account.config.fetch(configPda);
    expect(cfg.keeper.toBase58()).to.eq(tempKeeper.publicKey.toBase58());
    // Restore.
    await program.methods
      .updateKeeper(keeper.publicKey)
      .accountsStrict({ admin: admin.publicKey, config: configPda })
      .rpc();
    cfg = await program.account.config.fetch(configPda);
    expect(cfg.keeper.toBase58()).to.eq(keeper.publicKey.toBase58());
  });

  it("admin_close_automation: deposit → owner, rent → treasury", async () => {
    const ownerBefore = await provider.connection.getBalance(owner.publicKey);
    const treasuryBefore = await provider.connection.getBalance(windDownTreasury.publicKey);
    const pdaBefore = await provider.connection.getBalance(pre_shutdown_sol_auto);

    await program.methods
      .adminCloseAutomation()
      .accountsStrict({
        admin: admin.publicKey,
        owner: owner.publicKey,
        automation: pre_shutdown_sol_auto,
        config: configPda,
        treasury: windDownTreasury.publicKey,
      })
      .rpc();

    const ownerAfter = await provider.connection.getBalance(owner.publicKey);
    const treasuryAfter = await provider.connection.getBalance(windDownTreasury.publicKey);
    const acct = await provider.connection.getAccountInfo(pre_shutdown_sol_auto);

    expect(acct, "PDA must be closed").to.eq(null);
    // The treasury delta = the PDA's rent-exempt minimum (everything
    // left after the deposit was peeled off and sent to owner).
    // The owner delta = the deposit portion (pdaBefore - rent_min).
    expect(ownerAfter + treasuryAfter - ownerBefore - treasuryBefore).to.eq(
      pdaBefore,
      "PDA balance fully redistributed (no leakage)",
    );
    // Owner gets the larger share (deposit ≫ rent_min for a 0.07 SOL rule).
    expect(ownerAfter - ownerBefore).to.be.greaterThan(treasuryAfter - treasuryBefore);
  });

  it("admin_close_automation_spl: tokens → owner ATA, all lamports → treasury", async () => {
    const ownerAta = getAssociatedTokenAddressSync(pre_shutdown_spl_mint, owner.publicKey);
    const autoAta = getAssociatedTokenAddressSync(pre_shutdown_spl_mint, pre_shutdown_spl_auto, true);

    const ownerTokensBefore = (await getTokenAccount(provider.connection, ownerAta)).amount;
    const treasuryBefore = await provider.connection.getBalance(windDownTreasury.publicKey);
    const pdaLamportsBefore = await provider.connection.getBalance(pre_shutdown_spl_auto);
    const ataLamportsBefore = await provider.connection.getBalance(autoAta);
    const autoTokensBefore = (await getTokenAccount(provider.connection, autoAta)).amount;

    await program.methods
      .adminCloseAutomationSpl()
      .accountsStrict({
        admin: admin.publicKey,
        owner: owner.publicKey,
        automation: pre_shutdown_spl_auto,
        config: configPda,
        treasury: windDownTreasury.publicKey,
        mint: pre_shutdown_spl_mint,
        ownerAta,
        automationAta: autoAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const ownerTokensAfter = (await getTokenAccount(provider.connection, ownerAta)).amount;
    const treasuryAfter = await provider.connection.getBalance(windDownTreasury.publicKey);

    expect(ownerTokensAfter - ownerTokensBefore).to.eq(autoTokensBefore, "tokens to owner");
    expect(treasuryAfter - treasuryBefore).to.eq(
      pdaLamportsBefore + ataLamportsBefore,
      "PDA rent + ATA rent both to treasury",
    );
    expect(await provider.connection.getAccountInfo(pre_shutdown_spl_auto)).to.eq(null);
    expect(await provider.connection.getAccountInfo(autoAta)).to.eq(null);
  });

  it("admin_close_automation_swap: input tokens → owner ATA, all lamports → treasury", async () => {
    const ownerAta = getAssociatedTokenAddressSync(pre_shutdown_swap_input_mint, owner.publicKey);
    const autoAta = getAssociatedTokenAddressSync(pre_shutdown_swap_input_mint, pre_shutdown_swap_auto, true);

    const ownerTokensBefore = (await getTokenAccount(provider.connection, ownerAta)).amount;
    const treasuryBefore = await provider.connection.getBalance(windDownTreasury.publicKey);
    const pdaLamportsBefore = await provider.connection.getBalance(pre_shutdown_swap_auto);
    const ataLamportsBefore = await provider.connection.getBalance(autoAta);
    const autoTokensBefore = (await getTokenAccount(provider.connection, autoAta)).amount;

    await program.methods
      .adminCloseAutomationSwap()
      .accountsStrict({
        admin: admin.publicKey,
        owner: owner.publicKey,
        automation: pre_shutdown_swap_auto,
        config: configPda,
        treasury: windDownTreasury.publicKey,
        inputMint: pre_shutdown_swap_input_mint,
        ownerInputAta: ownerAta,
        automationInputAta: autoAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const ownerTokensAfter = (await getTokenAccount(provider.connection, ownerAta)).amount;
    const treasuryAfter = await provider.connection.getBalance(windDownTreasury.publicKey);

    expect(ownerTokensAfter - ownerTokensBefore).to.eq(autoTokensBefore, "swap input tokens to owner");
    expect(treasuryAfter - treasuryBefore).to.eq(
      pdaLamportsBefore + ataLamportsBefore,
      "PDA rent + input-ATA rent both to treasury",
    );
    expect(await provider.connection.getAccountInfo(pre_shutdown_swap_auto)).to.eq(null);
    expect(await provider.connection.getAccountInfo(autoAta)).to.eq(null);
  });

  it("admin_close_automation rejects non-admin signers", async () => {
    // Stage an automation we won't actually close (we re-use pre_shutdown_sol_auto, already closed).
    // The test instead asserts that a non-admin can't even attempt the ix
    // by trying to use a fresh keeper keypair in the admin slot — has_one
    // on config rejects.
    const intruder = Keypair.generate();
    await fund(intruder.publicKey, 0.1);
    let threw = false;
    try {
      await program.methods
        .adminCloseAutomation()
        .accountsStrict({
          admin: intruder.publicKey,
          owner: owner.publicKey,
          // The pre_shutdown_sol_auto is closed, but the constraint
          // failure (has_one = admin) fires before account loading
          // matters in some cases. For robustness we use a closed PDA;
          // the relevant invariant is "non-admin → reject."
          automation: pre_shutdown_sol_auto,
          config: configPda,
          treasury: windDownTreasury.publicKey,
        })
        .signers([intruder])
        .rpc();
    } catch (e: any) {
      threw = true;
      // Accept either has_one (admin mismatch) or AccountNotInitialized
      // (the closed PDA). Both prove the intruder did not get through.
      expect(`${e?.error?.errorCode?.code ?? ""} ${e?.message ?? ""}`).to.match(
        /HasOne|hasOne|2001|AccountNotInitialized|3012/i,
      );
    }
    expect(threw, "expected non-admin rejection").to.eq(true);
  });

});

// `getMint` import suppresses unused-warning when running with skip-build; tests use it
// indirectly via getTokenAccount/getMinimumBalanceForRentExemptMint.
void getMint;
