"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { createWalletClient, custom, formatUnits, getAddress, isAddress, recoverTypedDataAddress, hashTypedData, parseUnits,
  type Address, type EIP1193Provider, type TypedDataDefinition } from "viem";
import {
  EVM_DEVNET_PROGRAM, EVM_DEVNET_USDC_MINT, EVM_DEVNET_GENESIS, allocationTypedData, deriveEvmSafe, kaminoAllocation,
  withdrawalTypedData, lifecycleTypedData, isWithdrawalIntent, assertCanonicalEvmSignature, verifyEvmIntentSignature,
  type EvmOwnerIntent, type EvmSafeStatus,
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
type VerifiedRelay = { intent: EvmOwnerIntent; digest: string; relayMode: "operator" };

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
  const [reviewed, setReviewed] = useState(false);
  const [relayJob, setRelayJob] = useState<{ id: string; state: string; signature?: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const session = useRef(0);
  const [recipientOwner, setRecipientOwner] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("0.1");

  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (typeof detail?.provider?.request !== "function" || typeof detail.info?.name !== "string"
        || !(detail.info.uuid || detail.info.rdns)) return;
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
    return () => { window.removeEventListener("eip6963:announceProvider", onAnnounce); clearTimeout(fallback); session.current++; };
  }, []);

  const refresh = useCallback(async (owner: Address) => {
    const version = session.current;
    const next = await fetchStatus(owner);
    if (version !== session.current) throw new Error("Wallet session changed; connect and sign again");
    setVerified(null); setRelayJob(null); setReviewed(false); setSafe(next);
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
        session.current++; setBusy(false); setConnected(null); setSafe(null); setVerified(null); setRelayJob(null);
        setNotice("Wallet account changed. Connect again before signing.");
      }
    };
    const disconnected = () => { session.current++; setBusy(false); setConnected(null); setSafe(null); setVerified(null); setRelayJob(null); setNotice("Wallet disconnected. Connect again before signing."); };
    provider.on?.("accountsChanged", changed);
    provider.on?.("disconnect", disconnected);
    return () => { provider.removeListener?.("accountsChanged", changed); provider.removeListener?.("disconnect", disconnected); };
  }, [connected]);

  async function connect(wallet: BrowserWallet) {
    const version = ++session.current;
    setConnected(null);
    setBusy(true); setError(""); setNotice(""); setVerified(null); setRelayJob(null); setSafe(null);
    try {
      const accounts = await wallet.provider.request({ method: "eth_requestAccounts" });
      const first = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof first !== "string" || !isAddress(first)) throw new Error("Wallet returned no EVM account");
      const owner = getAddress(first);
      if (version !== session.current) return;
      setConnected({ wallet, owner });
      await refresh(owner);
    } catch (cause) {
      if (version !== session.current) return;
      setConnected(null);
      setError(walletError(cause));
    } finally { if (version === session.current) setBusy(false); }
  }

  async function signIntent() {
    if (!connected || busy || !reviewed || !safe?.exists) return;
    const version = session.current;
    setBusy(true); setError(""); setNotice(""); setVerified(null); setRelayJob(null);
    try {
      const accounts = await connected.wallet.provider.request({ method: "eth_accounts" });
      const first = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof first !== "string" || !isAddress(first) || getAddress(first) !== connected.owner) {
        throw new Error("Wallet account changed. Connect again before signing.");
      }
      if (version !== session.current) return;
      const fresh = await refresh(connected.owner);
      if (version !== session.current) return;
      const allocationBps = kaminoAllocation(kaminoPercent);
      const nonce = BigInt(fresh.nonce) + BigInt(1);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const typedData = allocationTypedData(new PublicKey(fresh.safe), allocationBps, nonce, deadline);
      const walletClient = createWalletClient({ account: connected.owner, transport: custom(connected.wallet.provider) });
      const signature = await walletClient.signTypedData(typedData);
      assertCanonicalEvmSignature(signature);
      const after = await connected.wallet.provider.request({ method: "eth_accounts" });
      if (version !== session.current || !Array.isArray(after) || typeof after[0] !== "string" || getAddress(after[0]) !== connected.owner) throw new Error("Wallet account changed; sign again");
      const recovered = await recoverTypedDataAddress({ ...typedData, signature });
      if (recovered !== connected.owner) throw new Error("Wallet signature does not match the connected account");
      const response = await fetch("/api/v2/evm-devnet", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: connected.owner, safe: fresh.safe, allocationBps,
          nonce: nonce.toString(), deadline: deadline.toString(), signature }),
      });
      const body = await response.json() as VerifiedRelay & { error?: string };
      if (!response.ok) throw new Error(body.error || "Server could not verify the signature");
      if (await verifyEvmIntentSignature(body.intent) !== hashTypedData(typedData) || body.digest !== hashTypedData(typedData)
        || body.intent.owner !== connected.owner || body.intent.safe !== fresh.safe
        || body.intent.nonce !== nonce.toString() || body.relayMode !== "operator") {
        throw new Error("Verified request differs from the message you signed");
      }
      if (version !== session.current) return;
      setVerified(body);
      setNotice("Signature verified. Copy the request and send it to the operator for Devnet relay.");
    } catch (cause) { if (version === session.current) setError(walletError(cause)); }
    finally { if (version === session.current) setBusy(false); }
  }

  function walletError(cause: unknown): string {
    let current = cause as { code?: number; cause?: unknown; message?: string } | undefined;
    for (let depth = 0; current && depth < 5; depth++) {
      if (current.code === 4001) return "Signature request cancelled by you.";
      if (current.code === 4100) return "Allow access to this EVM account and connect again.";
      if (current.code === 4200 || current.code === -32601) return "This wallet does not support EIP-712 typed signatures for this account.";
      if (current.code === 4900 || current.code === 4901) return "Wallet disconnected. Connect again.";
      current = current.cause as typeof current;
    }
    return cause instanceof Error ? cause.message : "Could not sign Devnet request";
  }

  async function signWithdrawal() {
    if (!connected || busy || !reviewed || !safe?.withdrawalEnabled) return;
    const version = session.current;
    setBusy(true); setError(""); setNotice(""); setVerified(null); setRelayJob(null);
    try {
      if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(withdrawAmount)) throw new Error("Enter a positive USDC amount with at most six decimals");
      const authority = new PublicKey(recipientOwner), recipient = getAssociatedTokenAddressSync(EVM_DEVNET_USDC_MINT, authority);
      const amountRaw = parseUnits(withdrawAmount, 6);
      const before = await connected.wallet.provider.request({ method: "eth_accounts" });
      if (!Array.isArray(before) || typeof before[0] !== "string" || getAddress(before[0]) !== connected.owner) throw new Error("Wallet account changed; connect again");
      const fresh = await refresh(connected.owner);
      if (!fresh.exists || !fresh.withdrawalEnabled || amountRaw > BigInt(fresh.usdcRaw)) throw new Error("Withdrawal unavailable or insufficient idle USDC");
      const nonce = BigInt(fresh.nonce) + BigInt(1), deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const typed = withdrawalTypedData(new PublicKey(fresh.safe), EVM_DEVNET_USDC_MINT, amountRaw, recipient, authority, nonce, deadline);
      const client = createWalletClient({ account: connected.owner, transport: custom(connected.wallet.provider) });
      const signature = await client.signTypedData(typed);
      assertCanonicalEvmSignature(signature);
      const after = await connected.wallet.provider.request({ method: "eth_accounts" });
      if (version !== session.current || !Array.isArray(after) || typeof after[0] !== "string" || getAddress(after[0]) !== connected.owner) throw new Error("Wallet account changed; sign again");
      const intent = { action: "withdraw_usdc" as const, cluster: "devnet" as const,
        program: EVM_DEVNET_PROGRAM.toBase58(), genesisHash: EVM_DEVNET_GENESIS,
        owner: connected.owner, safe: fresh.safe, mint: EVM_DEVNET_USDC_MINT.toBase58(),
        amountRaw: amountRaw.toString(), recipientTokenAccount: recipient.toBase58(), recipientOwner: authority.toBase58(),
        nonce: nonce.toString(), deadline: deadline.toString(), signature };
      await verifyEvmIntentSignature(intent);
      const response = await fetch("/api/v2/evm-devnet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent) });
      const body = await response.json() as VerifiedRelay & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not verify withdrawal");
      if (body.relayMode !== "operator" || body.digest !== hashTypedData(typed)
        || await verifyEvmIntentSignature(body.intent) !== hashTypedData(typed)) throw new Error("Verified withdrawal differs from the message you signed");
      if (version !== session.current) return;
      setVerified(body); setNotice("Withdrawal signature verified. Operator relay requires separate transaction approval.");
    } catch (cause) { if (version === session.current) setError(walletError(cause)); }
    finally { if (version === session.current) setBusy(false); }
  }

  async function signLifecycle(action: "create_safe" | "cancel_intents") {
    if (!connected || busy || !reviewed || !safe?.lifecycleEnabled) return;
    const version = session.current;
    setBusy(true); setError(""); setNotice(""); setVerified(null); setRelayJob(null);
    try {
      const before = await connected.wallet.provider.request({ method: "eth_accounts" });
      if (!Array.isArray(before) || typeof before[0] !== "string" || getAddress(before[0]) !== connected.owner) throw new Error("Wallet account changed; connect again");
      const fresh = await refresh(connected.owner);
      if (version !== session.current || !fresh.lifecycleEnabled) return;
      if (action === "create_safe" && fresh.sponsor !== safe.sponsor) throw new Error("Rent sponsor changed; review and sign again");
      if (action === "create_safe" && (fresh.exists || !fresh.sponsor)) throw new Error("Safe exists or no rent sponsor is configured");
      if (action === "cancel_intents" && !fresh.exists) throw new Error("Safe must exist before cancellation");
      const nonce = BigInt(fresh.nonce) + BigInt(1), deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const typed: TypedDataDefinition = lifecycleTypedData(new PublicKey(fresh.safe), nonce, deadline, action === "create_safe" ? new PublicKey(fresh.sponsor!) : undefined);
      const client = createWalletClient({ account: connected.owner, transport: custom(connected.wallet.provider) });
      const signature = await client.signTypedData(typed); assertCanonicalEvmSignature(signature);
      const after = await connected.wallet.provider.request({ method: "eth_accounts" });
      if (version !== session.current || !Array.isArray(after) || typeof after[0] !== "string" || getAddress(after[0]) !== connected.owner) throw new Error("Wallet account changed; sign again");
      const intent = { action, cluster: "devnet", program: EVM_DEVNET_PROGRAM.toBase58(), genesisHash: EVM_DEVNET_GENESIS,
        owner: connected.owner, safe: fresh.safe, nonce: nonce.toString(), deadline: deadline.toString(), signature,
        ...(action === "create_safe" ? { mint: EVM_DEVNET_USDC_MINT.toBase58(), rentPayer: fresh.sponsor! } : {}) };
      const response = await fetch("/api/v2/evm-devnet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(intent) });
      const body = await response.json() as VerifiedRelay & { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not verify authorization");
      if (body.relayMode !== "operator" || body.digest !== hashTypedData(typed) || await verifyEvmIntentSignature(body.intent) !== hashTypedData(typed)) throw new Error("Verified authorization differs from what you signed");
      if (version !== session.current) return;
      setVerified(body); setNotice(action === "create_safe" ? "Creation signature verified. The displayed sponsor pays rent; no funds are deposited." : "Cancellation signature verified. Pending requests become invalid only after cancellation confirms on-chain.");
    } catch (cause) { if (version === session.current) setError(walletError(cause)); }
    finally { if (version === session.current) setBusy(false); }
  }

  async function submitToRelayer() {
    if (!verified || busy || !connected) return;
    const version = session.current, signed = verified;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v2/evm-relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed.intent) });
      const job = await response.json() as { id: string; state: string; signature?: string; error?: string };
      if (!response.ok) throw new Error(job.error || "Relayer unavailable; copy the request for operator fallback");
      if (job.id !== signed.digest) throw new Error("Relayer returned a different request");
      if (version !== session.current) return;
      setRelayJob(job); setNotice(job.state === "quoted" ? "Relayer simulation passed. This request is awaiting separate operator approval." : "Relayer request accepted. Check its transaction status.");
    } catch (cause) { if (version === session.current) setError(walletError(cause)); }
    finally { if (version === session.current) setBusy(false); }
  }
  async function refreshRelay() {
    if (!relayJob || busy) return;
    const version = session.current, id = relayJob.id;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/v2/evm-relay?id=" + encodeURIComponent(id), { cache: "no-store" });
      const job = await response.json() as { id: string; state: string; signature?: string; error?: string };
      if (!response.ok || job.id !== id) throw new Error(job.error || "Could not read request status");
      if (version === session.current) { setRelayJob(job); setNotice(job.state === "finalized" ? "Transaction finalized. Refresh Safe state to see the balance and nonce." : "Relayer status: " + job.state); }
    } catch (cause) { if (version === session.current) setError(walletError(cause)); }
    finally { if (version === session.current) setBusy(false); }
  }

  let recipientAta = "Enter the receiving Solana wallet address";
  try { recipientAta = getAssociatedTokenAddressSync(EVM_DEVNET_USDC_MINT, new PublicKey(recipientOwner)).toBase58(); } catch { /* incomplete input */ }

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
        EVM funding and CCTP remain disabled. A signature authorizes the exact displayed action; anyone holding it can relay it before expiry.
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

      {connected && safe && <section className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Review authorization">
        <p className="font-medium">Review before signing</p>
        <p className="text-sm">Network: Solana Devnet. Safe: <span className="break-all font-mono">{safe.safe}</span></p>
        <p className="text-sm text-zinc-300">Next nonce: {(BigInt(safe.nonce) + BigInt(1)).toString()}. Authorization expires 10 minutes after signing. A signature is not tied to this website.</p>
        <label className="flex gap-3 text-sm"><input type="checkbox" checked={reviewed} disabled={busy} onChange={(event) => setReviewed(event.target.checked)} />I will verify the action, amount and recipient in the wallet prompt.</label>
        {!safe.exists && <>
          <p className="text-sm">Rent sponsor: <span className="break-all font-mono">{safe.sponsor || "Not configured"}</span>. You do not need a Solana account. Safe closure/rent refunds are disabled.</p>
          <button disabled={busy || !reviewed || !safe.lifecycleEnabled || !safe.sponsor} onClick={() => void signLifecycle("create_safe")} className="rounded-lg bg-violet-700 px-4 py-3 disabled:opacity-50">Sign Safe creation</button>
        </>}
        {safe.exists && <>
          <p className="text-sm text-zinc-300">Cancellation competes with pending requests at the next nonce. It cannot undo an action that executes first.</p>
          <button disabled={busy || !reviewed || !safe.lifecycleEnabled} onClick={() => void signLifecycle("cancel_intents")} className="rounded-lg border border-zinc-600 px-4 py-2 disabled:opacity-50">Sign cancellation of pending intents</button>
        </>}
        {!safe.lifecycleEnabled && <p className="text-sm text-amber-200">Creation and cancellation signing are disabled pending the reviewed Devnet upgrade.</p>}
      </section>}

      {connected && safe && <section className="space-y-4 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Sign allocation target">
        <div><h2 className="text-xl font-medium">3. Sign allocation target</h2><p className="mt-1 text-sm text-zinc-400">This changes the target only; it does not invest your USDC.</p></div>
        <label className="block text-sm" htmlFor="kamino-target">Kamino USDC target: <strong>{kaminoPercent}%</strong></label>
        <input id="kamino-target" type="range" min="0" max="100" step="1" value={kaminoPercent}
          disabled={busy} onChange={(event) => { setKaminoPercent(Number(event.target.value)); setReviewed(false); setVerified(null); setRelayJob(null); }}
          className="w-full accent-violet-500" />
        <p className="text-sm text-zinc-400">Idle target: {100 - kaminoPercent}%. ONyc and other routes stay at 0% in this probe.</p>
        <button disabled={busy || !reviewed || !safe.exists} onClick={() => void signIntent()}
          className="w-full rounded-lg bg-violet-700 px-4 py-3 font-medium hover:bg-violet-600 disabled:opacity-50 sm:w-auto">
          {busy ? "Working…" : "Sign Devnet setup message"}
        </button>
        <p className="text-xs text-zinc-400">The message binds this Safe, Devnet genesis, target, nonce and a 10-minute deadline. It sends no EVM transaction.</p>
      </section>}

      {connected && safe && <section className="space-y-4 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Sign USDC withdrawal">
        <h2 className="text-xl font-medium">4. Withdraw idle test USDC</h2>
        <p className="text-sm text-zinc-400">Receive on an existing Solana Devnet USDC account. Enter its Solana wallet address; your EVM address is not a Solana recipient.</p>
        <label className="block text-sm">Receiving Solana wallet
          <input disabled={busy} value={recipientOwner} onChange={(e) => { setRecipientOwner(e.target.value); setReviewed(false); setVerified(null); setRelayJob(null); }} className="mt-2 w-full rounded-lg border border-zinc-600 bg-zinc-950 p-3" />
        </label>
        <p className="break-all text-xs text-zinc-400">Exact receiving USDC account: {recipientAta}</p>
        <p className="break-all text-sm">Authorize withdrawal of <strong>{withdrawAmount} test USDC</strong> to <span className="font-mono">{recipientOwner || "Select recipient"}</span> on Solana Devnet.</p>
        <label className="block text-sm">USDC amount
          <input disabled={busy} value={withdrawAmount} onChange={(e) => { setWithdrawAmount(e.target.value); setReviewed(false); setVerified(null); setRelayJob(null); }} inputMode="decimal" className="mt-2 w-full rounded-lg border border-zinc-600 bg-zinc-950 p-3" />
        </label>
        {!safe.withdrawalEnabled && <p className="text-sm text-amber-200">Withdrawal signing is disabled pending the reviewed Devnet program upgrade.</p>}
        <button disabled={busy || !reviewed || !safe.withdrawalEnabled || !safe.exists || BigInt(safe.usdcRaw) === BigInt(0)} onClick={() => void signWithdrawal()} className="rounded-lg bg-violet-700 px-4 py-3 font-medium disabled:opacity-50">Sign USDC withdrawal</button>
      </section>}

      {error && <p role="alert" className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>}
      {notice && <p role="status" className="rounded-lg border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</p>}

      {verified && <section className="space-y-3 rounded-xl border border-zinc-700 bg-zinc-900/70 p-5" aria-label="Verified relay request">
        <h2 className="text-xl font-medium">Verified request</h2>
        <p className="text-sm text-zinc-300">Send this request to the operator before {new Date(Number(verified.intent.deadline) * 1000).toLocaleTimeString()}. The operator will simulate and relay it on Solana Devnet.</p>
        <p className="text-sm">Action: {"action" in verified.intent ? verified.intent.action : "set_allocation"}{isWithdrawalIntent(verified.intent) ? " · " + formatUnits(BigInt(verified.intent.amountRaw), 6) + " test USDC to " + verified.intent.recipientOwner : ""}</p>
        <button disabled={busy || !!relayJob} onClick={() => void submitToRelayer()} className="rounded-lg bg-violet-700 px-4 py-2 disabled:opacity-50">Submit to relayer</button>
        {relayJob && <div className="space-y-2 text-sm"><p>Relayer status: {relayJob.state}</p><button disabled={busy} onClick={() => void refreshRelay()} className="rounded-lg border border-zinc-500 px-3 py-2">Check transaction status</button>{relayJob.signature && <a className="block break-all underline" href={"https://explorer.solana.com/tx/" + relayJob.signature + "?cluster=devnet"} target="_blank" rel="noreferrer">View Solana transaction</a>}</div>}
        <button onClick={() => void copyIntent()} className="rounded-lg border border-zinc-500 px-4 py-2 text-sm hover:bg-zinc-800">Copy signed request</button>
        <textarea readOnly value={JSON.stringify(verified.intent)} rows={7}
          className="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-300" aria-label="Signed relay request" />
      </section>}
    </main>
  );
}
