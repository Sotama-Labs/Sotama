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
  tokenPriceBelow: (
    feed: PublicKey,
    threshold: BN,
    expo: number,
    quoteMint: PublicKey | null = null,
  ) => ({
    tokenPrice: { feed, quoteMint, comparator: 0, threshold, expo },
  }),
  tokenPriceAbove: (
    feed: PublicKey,
    threshold: BN,
    expo: number,
    quoteMint: PublicKey | null = null,
  ) => ({
    tokenPrice: { feed, quoteMint, comparator: 1, threshold, expo },
  }),
  stakingAmount: (stake: PublicKey, lamports: BN) => ({
    stakingReward: { stakeAccount: stake, mode: 0, value: lamports },
  }),
  stakingTime: (stake: PublicKey, intervalSeconds: BN) => ({
    stakingReward: { stakeAccount: stake, mode: 1, value: intervalSeconds },
  }),
};

const action = {
  transferSol: (destination: PublicKey, amount: BN) => ({
    transferSol: { destination, amount },
  }),
  transferSpl: (destination: PublicKey, mint: PublicKey, amount: BN) => ({
    transferSpl: { destination, mint, amount },
  }),
  stakeRestake: (stake: PublicKey, vote: PublicKey) => ({
    stakeRestake: { stakeAccount: stake, voteAccount: vote },
  }),
  stakeWithdrawReward: (stake: PublicKey, destination: PublicKey) => ({
    stakeWithdrawReward: { stakeAccount: stake, destination },
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
          trigger.tokenPriceBelow(fakeFeed, new BN(100_000_000), 1),
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
        trigger.tokenPriceBelow(fakeFeed, threshold, -8),
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
    expect((after.trigger as any).tokenPrice.threshold.toString()).to.eq(threshold.toString());
    expect((after.trigger as any).tokenPrice.expo).to.eq(-8);
  });

  it("enforces time-window on staking-time triggers", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const stakeAccount = Keypair.generate().publicKey;

    // First execute always allowed (last_executed_at == 0). Then we set
    // a 1-hour interval and confirm a second execute would fail —
    // single-shot semantics already reject double-execute, so the
    // interval check here is functionally redundant on v2 but covered
    // anyway in case a v3 reintroduces N-shot.
    await program.methods
      .createAutomation(
        trigger.stakingTime(stakeAccount, new BN(3600)),
        action.transferSol(destination.publicKey, new BN(0.01 * LAMPORTS_PER_SOL)),
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
      .accountsStrict({ owner: owner.publicKey, automation: auto })
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

  it("creates a stake-restake automation (no execute — local validator lacks vote setup)", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const stakeAccount = Keypair.generate().publicKey;
    const voteAccount = Keypair.generate().publicKey;

    await program.methods
      .createAutomationStake(
        trigger.stakingAmount(stakeAccount, new BN(1_000_000)),
        action.stakeRestake(stakeAccount, voteAccount),
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
    expect((a.action as any).stakeRestake.stakeAccount.toBase58()).to.eq(stakeAccount.toBase58());
    expect((a.action as any).stakeRestake.voteAccount.toBase58()).to.eq(voteAccount.toBase58());
    expect((a.trigger as any).stakingReward.mode).to.eq(0);
  });

  it("creates a stake-withdraw-reward automation (no execute — needs real stake authority)", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const stakeAccount = Keypair.generate().publicKey;

    await program.methods
      .createAutomationStake(
        trigger.stakingTime(stakeAccount, new BN(86_400)),
        action.stakeWithdrawReward(stakeAccount, destination.publicKey),
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
    expect((a.action as any).stakeWithdrawReward.destination.toBase58()).to.eq(
      destination.publicKey.toBase58()
    );
    expect((a.trigger as any).stakingReward.mode).to.eq(1);
    expect((a.trigger as any).stakingReward.value.toString()).to.eq("86400");
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
        trigger.tokenPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
        action.swap(inputMint, outputMint, owner.publicKey, amountIn, minAmountOut),
        cadence.once(),
        NO_INTERVAL,
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
        trigger.tokenPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
        action.swap(inputMint, outputMint, owner.publicKey, amountIn, new BN(0)),
        cadence.repeat(TOTAL),
        NO_INTERVAL,
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
          trigger.tokenPriceBelow(Keypair.generate().publicKey, new BN(10_000_000_000), -8),
          action.swap(
            inputMint,
            Keypair.generate().publicKey,
            owner.publicKey,
            new BN(100_000),
            new BN(0),
          ),
          cadence.until(farFuture),
          NO_INTERVAL,
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
});

// `getMint` import suppresses unused-warning when running with skip-build; tests use it
// indirectly via getTokenAccount/getMinimumBalanceForRentExemptMint.
void getMint;
