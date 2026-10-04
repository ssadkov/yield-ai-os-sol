"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { MOBILE_NETWORKS } from "@/lib/mobileNetworks";
import { checkedMobileTransaction, type MobileAction, type MobilePlan } from "@/lib/mobileSafeWallet";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then(m => m.WalletMultiButton), { ssr: false });
type Config = { network: typeof MOBILE_NETWORKS.mainnet | typeof MOBILE_NETWORKS.devnet; capabilities: { transactionSubmissionEnabled: boolean } };
type State = { exists: boolean; safe: string; idleUsdc: string; walletUsdc: string; walletSolLamports: string; executor: string | null };
type Pending = { signature: string; height: number; wire: string };
async function api(path: string, body?: unknown) {
  const response = await fetch(`/api/mobile/v1/${path}`, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Error(`${data.error?.code}: ${data.error?.message}`);
  return data;
}
function checkedConfig(config: Config) {
  const reviewed = MOBILE_NETWORKS[config.network.cluster];
  if (!reviewed || config.network.genesis !== reviewed.genesis || config.network.programId !== reviewed.programId || config.network.usdcMint !== reviewed.usdcMint || config.network.chain !== reviewed.chain) throw Error("API network configuration is not reviewed");
  return config;
}
export function V2MobileSafePanel() {
  const { publicKey, signTransaction } = useWallet();
  const owner = publicKey?.toBase58();
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const [config, setConfig] = useState<Config | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [amount, setAmount] = useState("1");
  const [review, setReview] = useState<{ plan: MobilePlan; action: MobileAction; amount: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [receipt, setReceipt] = useState("");
  const [message, setMessage] = useState("Loading network configuration…");
  const [busy, setBusy] = useState(false);
  const [journalReady, setJournalReady] = useState(false);
  const lock = useRef(false);
  const cluster = config?.network.cluster;
  const journalKey = owner && cluster ? `yield-ai-mobile-v1:${cluster}:${owner}` : null;
  useEffect(() => {
    let active = true;
    api("config").then(checkedConfig).then(value => { if (active) { setConfig(value); setMessage("Connect a Solana wallet, then refresh balances."); } }).catch(error => { if (active) setMessage(error.message); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    setState(null); setReview(null); setPending(null); setReceipt(""); setJournalReady(false);
    if (!journalKey) return;
    try {
      const saved = localStorage.getItem(journalKey);
      if (saved) {
        const p = JSON.parse(saved) as Pending;
        if (typeof p.signature !== "string" || bs58.decode(p.signature).length !== 64 || !Number.isSafeInteger(p.height) || p.height < 0 || typeof p.wire !== "string") throw Error();
        setPending(p); setReceipt(p.signature);
      }
      setJournalReady(true);
    } catch { setMessage("Unable to read the transaction journal. Check your last receipt before another transfer."); }
  }, [journalKey]);
  function assertOwner(expected: string) {
    if (ownerRef.current !== expected) throw Error("Wallet account changed. Refresh and prepare again.");
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function refresh() {
    if (!owner || !cluster) return;
    const value = await api(`safes?ownerType=solana&address=${owner}&cluster=${cluster}`);
    assertOwner(owner); setState(value);
  }
  async function prepare(action: MobileAction, input = amount) {
    if (!owner || !cluster || pending || !journalReady) throw Error("Connect a wallet and reconcile the pending signature first.");
    if (journalKey && localStorage.getItem(journalKey)) throw Error("A signed operation is already in the journal. Reload and reconcile it first.");
    setReview(null);
    const path = action.startsWith("create") ? "safes/creation-plan" : action === "deposit" ? "deposits/plan" : "withdrawals/plan";
    const plan = await api(path, { cluster, owner: { type: "solana", address: owner }, ...(action === "create_deposit" ? { initialDepositUsdc: input } : action === "create" ? {} : { amount: input }) });
    assertOwner(owner); setState(plan.state);
    if (plan.status !== "ready") { setMessage(plan.status === "already_exists" ? "Safe already exists. Use Deposit for another deposit." : "No idle USDC to withdraw."); return; }
    checkedMobileTransaction(plan, publicKey!, action, input, cluster);
    setReview({ plan, action, amount: input }); setMessage("Simulation passed. Review the amount, recipient and SOL cost.");
  }
  async function signAndSend() {
    if (!review || !config || !owner || !publicKey || !signTransaction || pending || !journalReady || !journalKey) throw Error("No signable plan");
    if (!config.capabilities.transactionSubmissionEnabled) throw Error("Sending is disabled for this deployment");
    if (localStorage.getItem(journalKey)) throw Error("A signed operation is already in the journal. Reload and reconcile it first.");
    // Refresh the deployment gate before opening a wallet approval.
    const current = checkedConfig(await api("config"));
    assertOwner(owner);
    if (!current.capabilities.transactionSubmissionEnabled || current.network.cluster !== config.network.cluster) throw Error("Network or submission configuration changed");
    const rpc = new Connection(`${window.location.origin}/api/mobile/v1/rpc`, { commitment: "confirmed", disableRetryOnRateLimit: true });
    if (await rpc.getGenesisHash() !== config.network.genesis) throw Error("RPC cluster mismatch");
    if (await rpc.getBlockHeight("confirmed") > review.plan.lastValidBlockHeight) { setReview(null); throw Error("Plan expired. Prepare again."); }
    assertOwner(owner);
    const tx = checkedMobileTransaction(review.plan, publicKey, review.action, review.amount, config.network.cluster);
    const reviewedMessage = Buffer.from(tx.message.serialize());
    const signed = await signTransaction(tx);
    if (!Buffer.from(signed.message.serialize()).equals(reviewedMessage) || signed.signatures[0].every(b => b === 0)) throw Error("Wallet did not sign the reviewed transaction");
    const saved = { signature: bs58.encode(signed.signatures[0]), height: review.plan.lastValidBlockHeight, wire: Buffer.from(signed.serialize()).toString("base64") };
    // Save under the signing owner's key even if the account changed while the wallet was open.
    localStorage.setItem(journalKey, JSON.stringify(saved));
    if (localStorage.getItem(journalKey) !== JSON.stringify(saved)) throw Error("Unable to persist the signed transaction. Nothing submitted.");
    assertOwner(owner); setPending(saved); setReceipt(saved.signature); setReview(null);
    setMessage(`Signed. Submitting to Solana ${config.network.cluster}…`);
    const result = await rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: "confirmed" });
    if (result !== saved.signature) throw Error("Returned signature mismatch. Check status.");
    assertOwner(owner); setMessage("Submitted. Check status until finalized.");
  }
  async function check() {
    if (!pending || !cluster || !owner || !journalKey) return;
    const result = await api(`transactions/${pending.signature}?cluster=${cluster}&lastValidBlockHeight=${pending.height}`);
    assertOwner(owner); setReceipt(pending.signature);
    setMessage(`Transaction: ${result.status}${result.reconciliationRequired ? ". History is inconclusive; inspect receipt and balances before another transfer." : ""}`);
    if (result.status === "finalized" || (result.status === "failed" && result.confirmationStatus === "finalized")) { localStorage.removeItem(journalKey); setPending(null); await refresh(); }
  }
  const mainnet = cluster === "mainnet";
  return <main className="mx-auto max-w-3xl space-y-5 p-6 text-white">
    <h1 className="text-3xl font-bold">Yield AI v2 · Mobile Safe pilot</h1>
    <p>{config ? `Solana ${mainnet ? "Mainnet · real USDC" : "Devnet · test USDC"}` : "Loading network…"}. Wallet → personal Safe → wallet.</p>
    <p>Deposits stay in USDC. This pilot does not invest into protocols.</p>
    {config && !config.capabilities.transactionSubmissionEnabled && <p className="rounded border border-amber-400 p-3 text-amber-200">Mainnet sending is disabled. You can inspect balances and prepare simulated unsigned plans.</p>}
    <WalletButton />
    <p className="break-all">Owner: {owner ?? "connect a wallet"}</p>
    <p>Rent and network fees are paid by this owner's SOL wallet.</p>
    <button disabled={busy || !owner || !config} onClick={() => run(refresh)} className="rounded bg-gray-700 px-4 py-2">Refresh balances</button>
    {state && <dl className="space-y-2 break-all"><dt>Safe</dt><dd>{state.safe} · {state.exists ? "created" : "not created"}</dd><dt>Wallet</dt><dd>{state.walletUsdc} USDC · {(Number(state.walletSolLamports) / 1e9).toFixed(6)} SOL</dd><dt>Idle Safe balance</dt><dd>{state.idleUsdc} USDC</dd><dt>Executor</dt><dd>{state.executor ?? "assigned at creation"}</dd></dl>}
    <label className="block">USDC amount <input className="ml-2 rounded border p-2" value={amount} onChange={event => { setAmount(event.target.value); setReview(null); }} inputMode="decimal" /></label>
    <div className="flex flex-wrap gap-3">{([
      ["create", "Create empty Safe"], ["create_deposit", "Create + first deposit"], ["deposit", "Deposit to Safe"], ["withdraw", "Withdraw amount"],
    ] as const).map(([action, label]) => <button key={action} className="rounded bg-violet-700 px-4 py-2 disabled:opacity-40" disabled={busy || !owner || !config || !!pending || !journalReady} onClick={() => run(() => prepare(action))}>{label}</button>)}
      <button className="rounded bg-violet-700 px-4 py-2 disabled:opacity-40" disabled={busy || !owner || !config || !!pending || !journalReady} onClick={() => run(() => prepare("withdraw", "all"))}>Withdraw all idle USDC</button>
    </div>
    {review && <section className="space-y-2 rounded border p-4"><p>{review.action} · {review.action === "create" ? "0" : review.amount === "all" ? review.plan.state.idleUsdc : review.amount} USDC · one owner signature</p><p className="break-all">{review.action === "withdraw" ? "Return to owner" : "Safe"}: {review.action === "withdraw" ? owner : review.plan.state.safe}</p><p>Total rent + fee: {(Number(review.plan.cost.totalLamports) / 1e9).toFixed(9)} SOL</p><button className="rounded bg-green-700 px-4 py-2 disabled:opacity-40" disabled={busy || !signTransaction || !config?.capabilities.transactionSubmissionEnabled} onClick={() => run(signAndSend)}>Sign and send on {mainnet ? "Mainnet" : "Devnet"}</button></section>}
    {pending && <button className="rounded bg-gray-700 px-4 py-2" disabled={busy} onClick={() => run(check)}>Check pending transaction</button>}
    <p role="status" className="break-words text-amber-200">{message}</p>
    {receipt && <a className="block break-all underline" href={`https://solscan.io/tx/${receipt}${mainnet ? "" : "?cluster=devnet"}`} target="_blank" rel="noreferrer">Transaction receipt: {receipt}</a>}
  </main>;
}
