"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { RPC_URL } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

export function SolanaProvider({ children }: { children: ReactNode }) {
  const useV2Proxy = process.env.NEXT_PUBLIC_V2_RPC_PROXY === "1";
  const [endpoint, setEndpoint] = useState(useV2Proxy ? "" : RPC_URL);
  useEffect(() => {
    if (useV2Proxy) setEndpoint(`${window.location.origin}/api/v2/mainnet-rpc`);
  }, [useV2Proxy]);
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  // Keep the server render and first client render identical; the proxy URL needs the browser origin.
  if (!endpoint) return null;

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
