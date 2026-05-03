"use client";

import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

export const RPC_URL =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com";

export const HAS_HELIUS = Boolean(process.env.NEXT_PUBLIC_HELIUS_RPC_URL);

export type Cluster = "mainnet-beta" | "devnet";

export const CLUSTER: Cluster =
  process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "devnet" ? "devnet" : "mainnet-beta";

export const CLUSTER_LABEL: Record<Cluster, string> = {
  "mainnet-beta": "Mainnet",
  devnet: "Devnet",
};

let cached: Rpc<SolanaRpcApi> | null = null;

export function getRpc(): Rpc<SolanaRpcApi> {
  if (!cached) cached = createSolanaRpc(RPC_URL);
  return cached;
}
