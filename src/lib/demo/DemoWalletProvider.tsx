"use client";

/* ─────────────────────────────────────────────────────────────────────
   Demo wallet — a fake, always-available "Demo" wallet for the public
   demo. It supplies the SAME React contexts that `useWallet()` and
   `useWalletModal()` read from, so every component keeps working without
   a browser wallet extension and without ever touching an RPC.

   Connect / disconnect cycle works: "Disconnect" flips to disconnected,
   and the WalletPill's "Connect wallet" button (which calls
   `setVisible(true)`) reconnects instantly instead of opening a modal.
   ───────────────────────────────────────────────────────────────────── */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  WalletContext,
  type Wallet,
  type WalletContextState,
} from "@solana/wallet-adapter-react";
import { WalletModalContext } from "@solana/wallet-adapter-react-ui";
import {
  WalletReadyState,
  type Adapter,
  type WalletName,
} from "@solana/wallet-adapter-base";
import { PublicKey } from "@solana/web3.js";
import { DEMO_OWNER } from "./demo";

const DEMO_PUBKEY = new PublicKey(DEMO_OWNER);

export function DemoWalletProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(true);

  const publicKey = useMemo(() => (connected ? DEMO_PUBKEY : null), [connected]);

  const connect = useCallback(async () => setConnected(true), []);
  const disconnect = useCallback(async () => setConnected(false), []);
  const select = useCallback(() => setConnected(true), []);

  const wallet = useMemo<Wallet>(() => {
    const adapter = {
      name: "Demo" as WalletName,
      url: "https://sotama.xyz",
      icon: "/logo-mark.svg",
      readyState: WalletReadyState.Installed,
      publicKey,
      connecting: false,
      connected,
      supportedTransactionVersions: null,
    } as unknown as Adapter;
    return { adapter, readyState: WalletReadyState.Installed };
  }, [publicKey, connected]);

  const walletValue = useMemo(
    () =>
      ({
        autoConnect: true,
        wallets: [wallet],
        wallet,
        publicKey,
        connecting: false,
        connected,
        disconnecting: false,
        select,
        connect,
        disconnect,
        // Writes never reach the chain in demo mode — these stubs exist
        // only so callers that check `wallet.signTransaction` truthiness
        // (DepositSheet, close flow) still type-check and short-circuit.
        sendTransaction: async () => "1111111111111111111111111111111111111111111111111111111111111111",
        signTransaction: async <T,>(tx: T) => tx,
        signAllTransactions: async <T,>(txs: T[]) => txs,
        signMessage: async (message: Uint8Array) => message,
        signIn: undefined,
      }) as unknown as WalletContextState,
    [wallet, publicKey, connected, select, connect, disconnect],
  );

  const modalValue = useMemo(
    () => ({
      visible: false,
      // "Connect wallet" → reconnect the demo wallet instead of opening a modal.
      setVisible: (open: boolean) => {
        if (open) setConnected(true);
      },
    }),
    [],
  );

  return (
    <WalletContext.Provider value={walletValue}>
      <WalletModalContext.Provider value={modalValue}>
        {children}
      </WalletModalContext.Provider>
    </WalletContext.Provider>
  );
}
