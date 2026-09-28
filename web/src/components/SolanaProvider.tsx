"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { RPC_URL } from "@/lib/constants";

import "@solana/wallet-adapter-react-ui/styles.css";

function WalletConnectionNotice({ message }: { message: string }) {
  const { publicKey } = useWallet();
  if (!message || publicKey) return null;
  return <p role="alert" className="p-3 text-amber-200">Solana wallet connection failed: {message}</p>;
}

export function SolanaProvider({ children }: { children: ReactNode }) {
  const useV2Proxy = process.env.NEXT_PUBLIC_V2_RPC_PROXY === "1";
  const [endpoint, setEndpoint] = useState(useV2Proxy ? "" : RPC_URL);
  const [walletError, setWalletError] = useState("");
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
      <WalletProvider wallets={wallets} autoConnect onError={(error, adapter) => {
        if (adapter?.name.toLowerCase() === "metamask" && error.name === "WalletAccountError") {
          setWalletError("MetaMask returned no Solana account to this site. In MetaMask, disconnect this site under Connected sites, reload, then select MetaMask here before connecting the Base account. Check the displayed Solana owner before creating a Safe.");
          return;
        }
        const cause = (error as Error & { cause?: unknown }).cause;
        const detail = cause instanceof Error && cause.message !== error.message ? `: ${cause.message}` : "";
        setWalletError(`${adapter?.name ?? "wallet"} ${error.name}: ${error.message}${detail}`);
      }}>
        <WalletModalProvider>
          <WalletConnectionNotice message={walletError} />
          {children}
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
