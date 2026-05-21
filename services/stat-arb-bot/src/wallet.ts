import { address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import bs58 from "bs58";

export type ExecutorWallet = {
  taker: string;
  signer: KeyPairSigner | null;
};

export async function loadExecutorWallet(args: {
  mode: "paper" | "jupiter-dry-run" | "jupiter-managed" | "helius-sender";
  privateKeyBase58?: string;
  taker?: string;
}): Promise<ExecutorWallet | null> {
  if (args.mode === "paper") return null;

  const signer = args.privateKeyBase58
    ? await signerFromBase58(args.privateKeyBase58)
    : null;
  const taker = signer?.address ?? args.taker;
  if (!taker) {
    throw new Error(
      `${args.mode} requires TRADE_EXECUTOR_TAKER or TRADE_EXECUTOR_PRIVATE_KEY_BS58`,
    );
  }
  validateAddress(taker);
  if ((args.mode === "jupiter-managed" || args.mode === "helius-sender") && !signer) {
    throw new Error(`${args.mode} requires TRADE_EXECUTOR_PRIVATE_KEY_BS58`);
  }
  return { taker, signer };
}

export async function signerFromBase58(secret: string): Promise<KeyPairSigner> {
  const decoded = bs58.decode(secret.trim());
  if (decoded.length !== 64) {
    throw new Error(`expected 64-byte base58 private key, received ${decoded.length} bytes`);
  }
  return createKeyPairSignerFromBytes(decoded);
}

function validateAddress(value: string): void {
  try {
    address(value);
  } catch {
    throw new Error("TRADE_EXECUTOR_TAKER is not a valid Solana public key");
  }
}
