"use client";

import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { createWalletClient, custom, formatUnits, getAddress, isAddress, recoverTypedDataAddress,
  type Address, type EIP1193Provider } from "viem";
import {
  EVM_DEVNET_PROGRAM, allocationTypedData, deriveEvmSafe, kaminoAllocation,
  type EvmRelayIntent, type EvmSafeStatus,
} from "@/lib/v2EvmDevnet";

type BrowserWallet = {
  id: string;
  name: string;
  provider: EIP1193Provider;
};
type Eip6963Detail = {
  info: { uuid: string; name: string; rdns: string };
  provider: EIP1193Provider;
};
type VerifiedRelay = { intent: EvmRelayIntent; digest: string; relayMode: "operator" };

async function fetchStatus(owner: Address): Promise<EvmSafeStatus> {
  const response = await fetch(`/api/v2/evm-devnet?owner=${encodeURIComponent(owner)}`, { cache: "no-store" });
  const body = await response.json() as EvmSafeStatus & { error?: string };
  if (!response.ok) throw new Error(body.error || "Could not read Solana Devnet");
  const derived = deriveEvmSafe(owner);
  if (body.cluster !== "devnet" || body.program !== EVM_DEVNET_PROGRAM.toBase58()
    || body.owner !== derived.owner || body.safe !== derived.safe.toBase58()
    || body.ata !== derived.ata.toBase58()) throw new Error("Devnet Safe addresses do not match this wallet");
  return body;
}

export function V2EvmDevnetPanel() {
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [connected, setConnected] = useState<{ wallet: BrowserWallet; owner: Address } | null>(null);
  const [safe, setSafe] = useState<EvmSafeStatus | null>(null);
  const [kaminoPercent, setKaminoPercent] = useState(50);
  const [verified, setVerified] = useState<VerifiedRelay | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (!detail?.provider || !detail.info?.name) return;
      const id = detail.info.uuid || detail.info.rdns;
      setWallets((current) => current.some((wallet) => wallet.id === id) ? current
        : [...current, { id, name: detail.info.name, provider: detail.provider }]);
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    const fallback = setTimeout(() => {
      const provider = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
      if (provider) setWallets((current) => current.length ? current
        : [{ id: "browser-evm", name: "Browser EVM wallet", provider }]);
    }, 500);
    return () => { window.removeEventListener("eip6963:announceProvider", onAnnounce); clearTimeout(fallback); };
  }, []);

  const refresh = useCallback(async (owner: Address) => {
    const next = await fetchStatus(owner);
    setSafe(next);
    return next;
  }, []);

  useEffect(() => {
    if (!connected) return;
    const provider = connected.wallet.provider as EIP1193Provider & {
      on?: (event: string, listener: (accounts: unknown) => void) => void;
      removeListener?: (event: string, listener: (accounts: unknown) => void) => void;
    };
    const changed = (accounts: unknown) => {
      const first = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof first !== "string" || !isAddress(first) || getAddress(first) !== connected.owner) {
        setConnected(null); setSafe(null); setVerified(null);
        setNotice("Wallet account changed. Connect again before signing.");
      }
    };
    provider.on?.("accountsChanged", changed);
    return () => provider.removeListener?.("accountsChanged", changed);
  }, [connected]);

  async function connect(wallet: BrowserWallet) {
    setBusy(true); setError(""); setNotice(""); setVerified(null); setSafe(null);
    try {
      const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
      const first = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof first !== "string" || !isAddress(first)) throw new Error("Wallet returned no EVM account");
      const owner = getAddress(first);
      setConnected({ wallet, owner });
      await refresh(owner);
    } catch (cause) {
      setConnected(null);
      setError(cause instanceof Error ? cause.message : "Could not connect EVM wallet");
    } finally { setBusy(false); }
  }

  async function signIntent() {
    if (!connected || busy) return;
    setBusy(true); setError(""); setNotice(""); setVerified(null);
    try {
      const accounts = await connected.wallet.provider.request({ method: "eth_accounts" });
      const first = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof first !== "string" || !isAddress(first) || getAddress(first) !== connected.owner) {
        throw new Error("Wallet account changed. Connect again before signing.");
      }
      const fresh = await refresh(connected.owner);
      const allocationBps = kaminoAllocation(kaminoPercent);
      const nonce = BigInt(fresh.nonce) + BigInt(1);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const typedData = allocationTypedData(new PublicKey(fresh.safe), allocationBps, nonce, deadline);
      const walletClient = createWalletClient({ account: connected.owner, transport: custom(connected.wallet.provider) });
      const signature = await walletClient.signTypedData(typedData);
      const recovered = await recoverTypedDataAddress({ ...typedData, signature });
      if (recovered !== connected.owner) throw new Error("Wallet signature does not match the connected account");
      const response = await fetch("/api/v2/evm-devnet", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: connected.owner, safe: fresh.safe, allocationBps,
          nonce: nonce.toString(), deadline: deadline.toString(), signature }),
      });
      const body = await response.json() as VerifiedRelay & { error?: string };
      if (!response.ok) throw new Error(body.error || "Server could not verify the signature");
      if (body.intent.owner !== connected.owner || body.intent.safe !== fresh.safe
        || body.intent.nonce !== nonce.toString() || body.relayMode !== "operator") {
        throw new Error("Verified request differs from the message you signed");
      }
      setVerified(body);
      setNotice("Signature verified. Copy the request and send it to the operator for Devnet relay.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not sign Devnet request"); }
    finally { setBusy(false); }
  }

  async function copyIntent() {
    if (!verified) return;
    try { await navigator.clipboard.writeText(JSON.stringify(verified.intent)); setNotice("Signed request copied."); }
    catch { setNotice("Clipboard unavailable. Select and copy the request below."); }
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-8 sm:px-6 sm:py-12">
      <header className="space-y-3">
        <p className="text-sm font-semibold tracking-wide text-violet-300">YIELD AI V2 · DEVNET LAB</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">EVM-owned Solana Safe</h1>
        <p className="max-w-2xl text-zinc-300">Connect MetaMask, Rabby or another EVM wallet. Your EVM address determines a Solana Safe; no Solana wallet or EVM gas is needed to sign this test message.</p>
      </header>

      <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-4 text-sm text-amber-100">
        This probe signs an allocation target only. It does not move tokens. Do not send USDC to this Safe: EVM-owner withdrawal is not implemented yet.
      </div>

      <section className="space-y-4 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Connect EVM wallet">
        <div><h2 className="text-xl font-medium">1. Connect EVM wallet</h2><p className="mt-1 text-sm text-zinc-400">Choose the account that will own this Devnet Safe.</p></div>
        <div className="flex flex-wrap gap-2">
          {wallets.length ? wallets.map((wallet) => (
            <button key={wallet.id} disabled={busy} onClick={() => void connect(wallet)}
              className="rounded-lg bg-violet-700 px-4 py-2.5 font-medium hover:bg-violet-600 disabled:opacity-50">
              Connect {wallet.name}
            </button>
          )) : <p className="text-sm text-zinc-400">No browser EVM wallet detected yet.</p>}
        </div>
        {connected && <div className="space-y-1 text-sm"><p>Wallet: <strong>{connected.wallet.name}</strong></p><p className="break-all font-mono text-zinc-300">{connected.owner}</p></div>}
      </section>

      {connected && <section className="space-y-4 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Devnet Safe state">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-medium">2. Review Safe</h2>
          <button disabled={busy} onClick={() => void refresh(connected.owner).catch((cause) => setError(cause instanceof Error ? cause.message : "Refresh failed"))}
            className="rounded-lg border border-zinc-600 px-3 py-2 text-sm hover:bg-zinc-800 disabled:opacity-50">Refresh state</button></div>
        {safe ? <dl className="space-y-3 text-sm">
          <div><dt className="text-zinc-400">Solana Devnet Safe</dt><dd className="break-all font-mono"><a className="underline" href={`https://explorer.solana.com/address/${safe.safe}?cluster=devnet`} target="_blank" rel="noreferrer">{safe.safe}</a></dd></div>
          <div><dt className="text-zinc-400">Test USDC account</dt><dd className="break-all font-mono">{safe.ata}</dd></div>
          <div className="flex gap-8"><div><dt className="text-zinc-400">State</dt><dd>{safe.exists ? "Created" : "Not created"}</dd></div><div><dt className="text-zinc-400">Nonce</dt><dd>{safe.nonce}</dd></div><div><dt className="text-zinc-400">USDC</dt><dd>{formatUnits(BigInt(safe.usdcRaw), 6)}</dd></div></div>
        </dl> : <p className="text-sm text-zinc-400">Reading Devnet state…</p>}
      </section>}

      {connected && safe && <section className="space-y-4 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Sign allocation target">
        <div><h2 className="text-xl font-medium">3. Sign allocation target</h2><p className="mt-1 text-sm text-zinc-400">This changes the target only. There are no tokens to deposit.</p></div>
        <label className="block text-sm" htmlFor="kamino-target">Kamino USDC target: <strong>{kaminoPercent}%</strong></label>
        <input id="kamino-target" type="range" min="0" max="100" step="1" value={kaminoPercent}
          onChange={(event) => { setKaminoPercent(Number(event.target.value)); setVerified(null); }}
          className="w-full accent-violet-500" />
        <p className="text-sm text-zinc-400">Idle target: {100 - kaminoPercent}%. ONyc and other routes stay at 0% in this probe.</p>
        <button disabled={busy} onClick={() => void signIntent()}
          className="w-full rounded-lg bg-violet-700 px-4 py-3 font-medium hover:bg-violet-600 disabled:opacity-50 sm:w-auto">
          {busy ? "Working…" : "Sign Devnet setup message"}
        </button>
        <p className="text-xs text-zinc-400">The message binds this Safe, Devnet genesis, target, nonce and a 10-minute deadline. It sends no EVM transaction.</p>
      </section>}

      {error && <p role="alert" className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
      {notice && <p role="status" className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</p>}

      {verified && <section className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Verified relay request">
        <h2 className="text-xl font-medium">Verified request</h2>
        <p className="text-sm text-zinc-300">Send this request to the operator before {new Date(Number(verified.intent.deadline) * 1000).toLocaleTimeString()}. The operator will simulate and relay it on Solana Devnet.</p>
        <button onClick={() => void copyIntent()} className="rounded-lg border border-zinc-500 px-4 py-2 text-sm hover:bg-zinc-800">Copy signed request</button>
        <textarea readOnly value={JSON.stringify(verified.intent)} rows={7}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-300" aria-label="Signed relay request" />
      </section>}
    </main>
  );
}
