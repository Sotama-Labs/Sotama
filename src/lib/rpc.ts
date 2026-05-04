"use client";

import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";

export type Cluster = "mainnet-beta" | "devnet";

export const CLUSTER: Cluster =
  process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "mainnet-beta" ? "mainnet-beta" : "devnet";

const PUBLIC_FALLBACK: Record<Cluster, string> = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
};

export const RPC_URL =
  process.env.NEXT_PUBLIC_HELIUS_RPC_URL || PUBLIC_FALLBACK[CLUSTER];

export const HAS_HELIUS = Boolean(process.env.NEXT_PUBLIC_HELIUS_RPC_URL);

export const MAINNET_METADATA_RPC_URL =
  process.env.NEXT_PUBLIC_HELIUS_MAINNET_RPC_URL || null;

export const CLUSTER_LABEL: Record<Cluster, string> = {
  "mainnet-beta": "Mainnet",
  devnet: "Devnet",
};

let cached: Rpc<SolanaRpcApi> | null = null;
let cachedMainnet: Rpc<SolanaRpcApi> | null = null;

export function getRpc(): Rpc<SolanaRpcApi> {
  if (!cached) cached = createSolanaRpc(RPC_URL);
  return cached;
}

/** Read-only mainnet RPC used purely for token-metadata fallback. Returns null when unconfigured. */
export function getMainnetMetadataRpc(): Rpc<SolanaRpcApi> | null {
  if (!MAINNET_METADATA_RPC_URL) return null;
  if (!cachedMainnet) cachedMainnet = createSolanaRpc(MAINNET_METADATA_RPC_URL);
  return cachedMainnet;
}
