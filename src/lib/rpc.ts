"use client";

import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

const RPC_URL =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";

let cached: Rpc<SolanaRpcApi> | null = null;

export function getRpc(): Rpc<SolanaRpcApi> {
  if (!cached) cached = createSolanaRpc(RPC_URL);
  return cached;
}

export const CLUSTER =
  (process.env.NEXT_PUBLIC_SOLANA_CLUSTER as "mainnet-beta" | "devnet") ||
  "mainnet-beta";

export const HAS_HELIUS = Boolean(process.env.NEXT_PUBLIC_HELIUS_RPC_URL);
