/* ─────────────────────────────────────────────────────────────────────
   Sotama escrow program — config slot.
   The program ships separately; this module exists so IX builders can
   plug in once the IDL lands. Today it's just the env-driven program ID
   and the cluster the program targets.
   ───────────────────────────────────────────────────────────────────── */

import { CLUSTER, type Cluster } from "./rpc";

export const SOTAMA_PROGRAM_ID: string | null =
  process.env.NEXT_PUBLIC_SOTAMA_PROGRAM_ID || null;

export const PROGRAM_CLUSTER: Cluster = CLUSTER;

export function isProgramConfigured(): boolean {
  return Boolean(SOTAMA_PROGRAM_ID);
}
