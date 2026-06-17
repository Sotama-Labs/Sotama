"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";

import "@solana/wallet-adapter-react-ui/styles.css";
import { RPC_URL } from "@/lib/rpc";
import { DEMO_RPC_ENDPOINT, isDemoMode } from "@/lib/demo/demo";
import { DemoWalletProvider } from "@/lib/demo/DemoWalletProvider";

export function Providers({ children }: { children: ReactNode }) {
  // Standard wallets (Phantom, Backpack, etc.) auto-register via the Wallet Standard;
  // these adapters cover the long tail that hasn't migrated yet. Skipped entirely in
  // demo mode — the demo uses a fake in-memory wallet and never talks to a real one.
  const wallets = useMemo(
    () => (isDemoMode() ? [] : [new PhantomWalletAdapter(), new SolflareWalletAdapter()]),
    [],
  );

  // Demo mode: a fake, always-available wallet over a key-less public RPC
  // endpoint that's never actually called (every RPC path is gated off).
  if (isDemoMode()) {
    return (
      <ConnectionProvider endpoint={DEMO_RPC_ENDPOINT}>
        <DemoWalletProvider>{children}</DemoWalletProvider>
      </ConnectionProvider>
    );
  }

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
