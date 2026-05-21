import { expect } from "chai";
import { loadExecutorWallet } from "../src/wallet";

const TEST_TAKER = "By591hpHfkAozWKVJ43fhEREWcuHL9GdNEVFH2smiiwz";
const TEST_PRIVATE_KEY_BS58 =
  "3x6UtjDtafXwHGzEuSmRpJqfN3PMZMJs9YvYxcGsPa2dzk71kD9ReM82J8ZsRrzKxuj8gqrpHeATSho3p8L4V4pY";

describe("executor wallet loading", () => {
  it("stays unset in paper mode", async () => {
    expect(await loadExecutorWallet({ mode: "paper" })).to.equal(null);
  });

  it("accepts a taker-only dry-run wallet", async () => {
    const wallet = await loadExecutorWallet({ mode: "jupiter-dry-run", taker: TEST_TAKER });
    expect(wallet?.taker).to.equal(TEST_TAKER);
    expect(wallet?.signer).to.equal(null);
  });

  it("derives the taker from a base58 private key", async () => {
    const wallet = await loadExecutorWallet({
      mode: "jupiter-managed",
      privateKeyBase58: TEST_PRIVATE_KEY_BS58,
    });
    expect(wallet?.taker).to.equal(TEST_TAKER);
    expect(wallet?.signer?.address).to.equal(TEST_TAKER);
  });

  it("requires a signer for live execution modes", async () => {
    try {
      await loadExecutorWallet({ mode: "helius-sender", taker: TEST_TAKER });
      throw new Error("expected loadExecutorWallet to throw");
    } catch (e: any) {
      expect(e.message).to.contain("requires TRADE_EXECUTOR_PRIVATE_KEY_BS58");
    }
  });
});
