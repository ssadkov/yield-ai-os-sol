"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  MAINNET_GENESIS, explorerTx, ixConfigureExecutorRegistry, readExecutorRegistry,
  readProtocolAdmin, sendOwnerTransaction, type ExecutorRegistryState,
} from "@/lib/safeV2";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false },
);

export function ExecutorRegistryAdmin() {
  const { connection } = useConnection();
  const { publicKey, wallet } = useWallet();
  const [genesis, setGenesis] = useState<string | null>(null);
  const [admin, setAdmin] = useState<PublicKey | null>(null);
  const [registry, setRegistry] = useState<ExecutorRegistryState | null>(null);
  const [approvedText, setApprovedText] = useState("");
  const [defaultText, setDefaultText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const refresh = useCallback(async () => {
    if (!publicKey) { setAdmin(null); setRegistry(null); return; }
    const chain = await connection.getGenesisHash();
    setGenesis(chain);
    if (chain !== MAINNET_GENESIS) throw new Error("Executor registry admin requires Solana Mainnet");
    const [nextAdmin, nextRegistry] = await Promise.all([
      readProtocolAdmin(connection, publicKey), readExecutorRegistry(connection, publicKey),
    ]);
    setAdmin(nextAdmin);
    setRegistry(nextRegistry);
    setApprovedText(nextRegistry?.approved.map((key) => key.toBase58()).join("\n") ?? "");
    setDefaultText(nextRegistry?.defaultExecutor.equals(PublicKey.default)
      ? "" : nextRegistry?.defaultExecutor.toBase58() ?? "");
  }, [connection, publicKey]);

  useEffect(() => { void refresh().catch((error) => setMessage(String(error))); }, [refresh]);

  async function save() {
    if (!publicKey || !wallet || !admin?.equals(publicKey) || genesis !== MAINNET_GENESIS) return;
    setBusy(true);
    setMessage("");
    try {
      const approved = approvedText.split(/[\s,]+/).filter(Boolean).map((raw) => new PublicKey(raw));
      const defaultExecutor = defaultText.trim() ? new PublicKey(defaultText.trim()) : PublicKey.default;
      const instruction = await ixConfigureExecutorRegistry(connection, publicKey, defaultExecutor, approved);
      const signature = await sendOwnerTransaction({
        connection, adapter: wallet.adapter, owner: publicKey, instructions: [instruction],
        onStatus: setMessage,
      });
      setMessage(`Confirmed: ${explorerTx(signature, genesis)}`);
      await refresh();
    } catch (error) {
      setMessage(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-2xl space-y-5 p-5 text-sm">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Executor whitelist</h1>
        <p className="text-muted-foreground">The protocol admin selects which executor keys may act for Safes and which one new Safes receive.</p></div>
      <WalletMultiButton />
    </header>
    <section className="space-y-3 rounded-lg border border-border bg-card p-5">
      <p>Cluster: {genesis === MAINNET_GENESIS ? "Solana Mainnet" : genesis ?? "Connect a wallet"}</p>
      <p className="break-all">Protocol admin: {admin?.toBase58() ?? "…"}</p>
      <p>Registry: {registry ? registry.address.toBase58() : "Not initialized"}</p>
      <p className="text-muted-foreground">Removing an address immediately stops its agent transactions. Existing Safe owners retain withdrawal rights and may approve the new default with one wallet signature.</p>
      <label className="block space-y-1"><span>Approved executor public keys, one per line (maximum 16)</span>
        <textarea className="min-h-32 w-full rounded-md border border-border bg-transparent p-2 font-mono text-xs"
          value={approvedText} onChange={(event) => setApprovedText(event.target.value)} disabled={busy || !admin?.equals(publicKey ?? PublicKey.default)} /></label>
      <label className="block space-y-1"><span>Default executor for new Safes</span>
        <input className="w-full rounded-md border border-border bg-transparent p-2 font-mono text-xs" placeholder="Leave blank to pause new Safe creation"
          value={defaultText} onChange={(event) => setDefaultText(event.target.value)} disabled={busy || !admin?.equals(publicKey ?? PublicKey.default)} /></label>
      <div className="flex gap-2">
        <button type="button" className="rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-40"
          disabled={busy || !publicKey || !admin?.equals(publicKey) || genesis !== MAINNET_GENESIS} onClick={() => void save()}>
          {registry ? "Update whitelist" : "Initialize whitelist"}</button>
        <button type="button" className="rounded-md border border-border px-3 py-2 disabled:opacity-40"
          disabled={busy || !publicKey} onClick={() => void refresh().catch((error) => setMessage(String(error)))}>Refresh</button>
      </div>
      {message && <p className="break-all font-mono text-xs">{message}</p>}
    </section>
  </main>;
}
