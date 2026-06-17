/* ─────────────────────────────────────────────────────────────────────
   Demo mode — the public beta.sotama.xyz "still being built" demo.

   When `NEXT_PUBLIC_DEMO_MODE === "true"` the app runs with NO Solana
   RPC, NO keeper backend, and NO real wallet. Every on-chain / keeper
   read is short-circuited to dummy data and every write is simulated.
   The only remaining live network calls are the FREE public price
   endpoints (Jupiter Lite + Pyth Hermes) so tickers and price previews
   still feel alive.

   The flag is read from a `NEXT_PUBLIC_*` env var, so it is inlined at
   build time — a stable boolean across server and client. That keeps it
   SSR-safe and usable from both client components and plain modules
   (no React context plumbing, no hydration mismatch).

   To run the demo locally:  NEXT_PUBLIC_DEMO_MODE=true pnpm dev
   ───────────────────────────────────────────────────────────────────── */

export const DEMO_MODE: boolean = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/** Single source of truth for the demo toggle. */
export function isDemoMode(): boolean {
  return DEMO_MODE;
}

/** Fixed identity for the demo wallet. A real, valid ed25519 base58
 *  pubkey so `new PublicKey(DEMO_OWNER)` succeeds and the address renders
 *  like any other — but it never signs or holds anything: every RPC path
 *  is short-circuited in demo mode. */
export const DEMO_OWNER = "GxQSG4TQqFDx3bzquiJSQXrm4Sqvf2JXbprqqg1bMvUD";

/** SOL balance shown for the demo wallet (used by useWalletBalance). */
export const DEMO_SOL_BALANCE = 18.42;

/** Endpoint handed to the wallet-adapter ConnectionProvider in demo mode.
 *  A public, key-less RPC URL purely so the Connection object constructs —
 *  it is never actually called because every RPC code path is gated off
 *  in demo mode. Keeping it key-less avoids shipping a Helius key in the
 *  demo bundle. */
export const DEMO_RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";
