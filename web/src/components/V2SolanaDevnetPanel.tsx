"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { checkedDevnetTransaction, DEVNET_GENESIS, type DevnetAction, type DevnetPlan } from "@/lib/mobileDevnetWallet";
const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then(m => m.WalletMultiButton), { ssr: false });
const rpc = new Connection("https://api.devnet.solana.com", "confirmed");
type State = { exists: boolean; safe: string; idleUsdc: string; walletUsdc: string; walletSolLamports: string };
type Pending = { signature: string; height: number; wire: string };
async function api(path: string, body?: unknown) {
  const r = await fetch(`/api/mobile/v1/${path}`, { cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await r.json(); if (!r.ok) throw Error(`${data.error?.code}: ${data.error?.message}`); return data;
}
export function V2SolanaDevnetPanel() {
  const { publicKey, signTransaction } = useWallet();
  const owner = publicKey?.toBase58();
  const [state, setState] = useState<State | null>(null);
  const [amount, setAmount] = useState("1");
  const [review, setReview] = useState<{ plan: DevnetPlan; action: DevnetAction; amount: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState("Connect a Solana wallet. Use test tokens only.");
  const [receipt, setReceipt] = useState("");
  const [busy, setBusy] = useState(false);
  const [journalUnavailable, setJournalUnavailable] = useState(false);
  const lock = useRef(false);
  const journalKey = `yield-ai-devnet-v1:${owner ?? "none"}`;
  useEffect(() => {
    setState(null); setReview(null); setPending(null); setReceipt(""); setJournalUnavailable(false);
    if (!owner) return;
    try {
      const saved = localStorage.getItem(journalKey);
      if (saved) {
        const p = JSON.parse(saved);
        if (typeof p.signature !== "string" || !Number.isSafeInteger(p.height) || typeof p.wire !== "string") throw Error();
        setPending(p);
      }
    } catch { setJournalUnavailable(true); setMessage("Unable to read the transaction journal; check your last signature before retrying."); }
  }, [owner, journalKey]);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : "Request failed"); }
    finally { lock.current = false; setBusy(false); }
  }
  async function refresh() { if (owner) setState(await api(`safes?ownerType=solana&address=${owner}&cluster=devnet`)); }
  async function prepare(action: DevnetAction, input = amount) {
    if (!owner || pending || journalUnavailable) throw Error("Connect a wallet and reconcile the pending signature first.");
    setReview(null);
    const path = action.startsWith("create") ? "safes/creation-plan" : action === "deposit" ? "deposits/plan" : "withdrawals/plan";
    const plan = await api(path, { cluster: "devnet", owner: { type: "solana", address: owner }, ...(action === "create_deposit" ? { initialDepositUsdc: input } : action === "create" ? {} : { amount: input }) });
    setState(plan.state);
    if (plan.status !== "ready") { setMessage(plan.status === "already_exists" ? "Safe already exists. Use Deposit for another deposit." : "No idle USDC to withdraw."); return; }
    checkedDevnetTransaction(plan, publicKey!, action, input);
    setReview({ plan, action, amount: input }); setMessage("Review the amount and SOL cost, then sign once in your wallet.");
  }
  async function signAndSend() {
    if (!review || !publicKey || !signTransaction || pending || journalUnavailable) throw Error("No signable plan");
    if (await rpc.getGenesisHash() !== DEVNET_GENESIS) throw Error("RPC is not Devnet");
    if (await rpc.getBlockHeight("confirmed") > review.plan.lastValidBlockHeight) { setReview(null); throw Error("Plan expired. Prepare again."); }
    const tx = checkedDevnetTransaction(review.plan, publicKey, review.action, review.amount);
    const reviewedMessage = Buffer.from(tx.message.serialize());
    const signed = await signTransaction(tx);
    if (!Buffer.from(signed.message.serialize()).equals(reviewedMessage) || signed.signatures[0].every(b => b === 0)) throw Error("Wallet did not sign the reviewed transaction");
    const saved = { signature: bs58.encode(signed.signatures[0]), height: review.plan.lastValidBlockHeight, wire: Buffer.from(signed.serialize()).toString("base64") };
    // Journal before network send. A send timeout cannot trigger another transfer automatically.
    localStorage.setItem(journalKey, JSON.stringify(saved)); setPending(saved); setReceipt(saved.signature); setReview(null);
    setMessage("Signed. Submitting to Solana Devnet…");
    const result = await rpc.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 2, preflightCommitment: "confirmed" });
    if (result !== saved.signature) throw Error("Returned signature mismatch. Check status.");
    setMessage("Submitted. Check status until finalized.");
  }
  async function check() {
    if (!pending) return;
    const s = await api(`transactions/${pending.signature}?cluster=devnet&lastValidBlockHeight=${pending.height}`);
    setReceipt(pending.signature); setMessage(`Transaction: ${s.status}${s.reconciliationRequired ? ". History is inconclusive; inspect the receipt and balances before another transfer." : ""}`);
    if (s.status === "finalized" || (s.status === "failed" && s.confirmationStatus === "finalized")) { localStorage.removeItem(journalKey); setPending(null); await refresh(); }
  }
  return <main className="mx-auto max-w-3xl space-y-5 p-6 text-white">
    <h1 className="text-3xl font-bold">Yield AI v2 · Devnet Safe test</h1>
    <p>Test USDC only. Wallet → personal Safe → wallet. Kamino is not used in this test.</p>
    <WalletButton />
    <p className="break-all">Owner: {owner ?? "connect a wallet"}</p>
    <p>Fund this owner with <a className="underline" href="https://faucet.solana.com/" target="_blank" rel="noreferrer">Devnet SOL</a> and <a className="underline" href="https://faucet.circle.com/" target="_blank" rel="noreferrer">Circle USDC (Solana Devnet)</a>. Rent and fees are paid by your wallet.</p>
    <button disabled={busy || !owner} onClick={() => run(refresh)} className="rounded bg-gray-700 px-4 py-2">Refresh balances</button>
    {state && <dl className="space-y-2 break-all"><dt>Safe</dt><dd>{state.safe} · {state.exists ? "created" : "not created"}</dd><dt>Wallet</dt><dd>{state.walletUsdc} USDC · {(Number(state.walletSolLamports) / 1e9).toFixed(6)} devnet SOL</dd><dt>Idle Safe balance</dt><dd>{state.idleUsdc} USDC</dd></dl>}
    <label className="block">USDC amount <input className="ml-2 rounded border p-2" value={amount} onChange={e => { setAmount(e.target.value); setReview(null); }} inputMode="decimal" /></label>
    <div className="flex flex-wrap gap-3">{([
      ["create", "Create empty Safe"], ["create_deposit", "Create + first deposit"], ["deposit", "Deposit to Safe"], ["withdraw", "Withdraw amount"],
    ] as const).map(([action, label]) => <button key={action} className="rounded bg-violet-700 px-4 py-2 disabled:opacity-40" disabled={busy || !owner || !!pending || journalUnavailable} onClick={() => run(() => prepare(action))}>{label}</button>)}
      <button className="rounded bg-violet-700 px-4 py-2 disabled:opacity-40" disabled={busy || !owner || !!pending || journalUnavailable} onClick={() => run(() => prepare("withdraw", "all"))}>Withdraw all idle USDC</button>
    </div>
    {review && <section className="space-y-2 rounded border p-4"><p>{review.action} · {review.amount === "all" ? review.plan.state.idleUsdc : review.amount} USDC · one owner signature</p><p>Total rent + fee: {(Number(review.plan.cost.totalLamports) / 1e9).toFixed(9)} devnet SOL</p><button className="rounded bg-green-700 px-4 py-2" disabled={busy || !signTransaction} onClick={() => run(signAndSend)}>Sign and send on Devnet</button></section>}
    {pending && <button className="rounded bg-gray-700 px-4 py-2" disabled={busy} onClick={() => run(check)}>Check pending transaction</button>}
    <p role="status" className="break-words text-amber-200">{message}</p>
    {receipt && <a className="block break-all underline" href={`https://solscan.io/tx/${receipt}?cluster=devnet`} target="_blank" rel="noreferrer">Devnet receipt: {receipt}</a>}
  </main>;
}
