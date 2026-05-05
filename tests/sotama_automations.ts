import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
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

describe("sotama_automations", () => {
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
      fund(owner.publicKey, 10),
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

  it("creates an automation and holds the deposit on the PDA", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.5 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(watched.publicKey, destination.publicKey, amount)
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
    expect(a.watchedAccount.toBase58()).to.eq(watched.publicKey.toBase58());
    expect(a.destination.toBase58()).to.eq(destination.publicKey.toBase58());
    expect(a.amountLamports.toString()).to.eq(amount.toString());
    expect(a.executed).to.eq(false);
    expect(a.nonce.toString()).to.eq(nonce.toString());

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
        .createAutomation(watched.publicKey, destination.publicKey, new BN(100))
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
      const code = e?.error?.errorCode?.code ?? "";
      const msg = e?.message ?? "";
      expect(`${code} ${msg}`).to.match(/DepositTooSmall/);
    }
    expect(threw, "expected DepositTooSmall").to.eq(true);
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
      const code = e?.error?.errorCode?.code ?? "";
      const msg = e?.message ?? "";
      expect(`${code} ${msg}`).to.match(/UnauthorizedKeeper/);
    }
    expect(threw, "expected UnauthorizedKeeper").to.eq(true);
  });

  it("executes via the keeper and transfers SOL to destination", async () => {
    const auto = automationPdaFor(program.programId, owner.publicKey, 0n);
    const a = await program.account.automation.fetch(auto);
    const amount = a.amountLamports.toNumber();

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
    expect(after.executed).to.eq(true);
    expect(after.executedAt.toNumber()).to.be.greaterThan(0);
  });

  it("rejects double-execute", async () => {
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
      const code = e?.error?.errorCode?.code ?? "";
      const msg = e?.message ?? "";
      expect(`${code} ${msg}`).to.match(/AlreadyExecuted/);
    }
    expect(threw, "expected AlreadyExecuted").to.eq(true);
  });

  it("rejects execute when paused, allows again after unpause", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.1 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(watched.publicKey, destination.publicKey, amount)
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
      const code = e?.error?.errorCode?.code ?? "";
      const msg = e?.message ?? "";
      expect(`${code} ${msg}`).to.match(/Paused/);
    }
    expect(threw, "expected Paused").to.eq(true);

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
    expect(after.executed).to.eq(true);
  });

  it("closes a fresh automation and refunds owner", async () => {
    const cfg = await program.account.config.fetch(configPda);
    const nonce = BigInt(cfg.automationCount.toString());
    const auto = automationPdaFor(program.programId, owner.publicKey, nonce);
    const amount = new BN(0.2 * LAMPORTS_PER_SOL);

    await program.methods
      .createAutomation(watched.publicKey, destination.publicKey, amount)
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
});
