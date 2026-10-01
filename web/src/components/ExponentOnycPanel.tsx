"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PROGRAM_ID } from "@/lib/constants";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false },
);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MATURITY = Date.parse("2027-01-10T13:00:00Z") / 1000;
type Action = "setup" | "deposit_onyc" | "withdraw_onyc" | "buy" | "sell" | "redeem";
type Asset = "USDC" | "ONYC";
type Quote = {
  action: Action; asset: Asset; owner: string; input: { raw: string }; output: { expectedRaw: string; minRaw: string };
  slot: string; chainTime: number; expiresAt: number; nav: string; executionReady: boolean; previewOnly: boolean;
  economicAllowed: boolean; lossFloorUsdc: string | null; basisUsdc: string | null;
  position: { trackedPt: string; principalUsdc: string } | null;
  maturityPreview: { onycRaw: string; usdcAtCurrentDexRaw: string; assumption: string } | null;
};
type Prepared = {
  unsignedTransaction: string; blockhash: string; lastValidBlockHeight: number; requiredSigners: string[];
  simulation: { error: unknown; unitsConsumed: number | null }; executionReady: boolean;
  deploymentStatus: string; networkFeeLamports: number | null; quote?: Quote; minimumOutputRaw?: string; intentKey?: string;
};

function toRaw(value: string, decimals: number): string | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match || (match[2]?.length ?? 0) > decimals) return null;
  const raw = BigInt(match[1]) * BigInt(10) ** BigInt(decimals)
    + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
  return raw > BigInt(0) ? raw.toString() : null;
}

function fromRaw(value: string, decimals: number): string {
  const raw = BigInt(value), scale = BigInt(10) ** BigInt(decimals);
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${raw / scale}${fraction ? `.${fraction}` : ""}`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body as T;
}

export function ExponentOnycPanel() {
  const { connection } = useConnection();
  const { publicKey, signTransaction, wallet } = useWallet();
  const [genesis, setGenesis] = useState<string | null>(null);
  const [action, setAction] = useState<Action>("buy");
  const [asset, setAsset] = useState<Asset>("USDC");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [signature, setSignature] = useState<string | null>(null);
  const owner = publicKey?.toBase58() ?? null;
  const trade = action === "buy" || action === "sell" || action === "redeem";
  const decimals = action === "sell" || action === "redeem" ? 9 : asset === "USDC" && action === "buy" ? 6 : 9;
  const raw = trade || action !== "setup" ? toRaw(amount, decimals) : null;
  const intentKey = `${owner}|${action}|${asset}|${raw ?? ""}`;
  const currentQuote = quote?.owner === owner && quote.action === action && quote.asset === asset && quote.input.raw === raw ? quote : null;
  const currentPrepared = prepared?.intentKey === intentKey ? prepared : null;
  const mainnet = genesis === MAINNET_GENESIS;
  const card = "rounded-lg border border-border bg-card p-5 space-y-4";
  const button = "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed";

  useEffect(() => {
    let cancelled = false;
    connection.getGenesisHash().then((hash) => { if (!cancelled) setGenesis(hash); })
      .catch(() => { if (!cancelled) setGenesis(null); });
    return () => { cancelled = true; };
  }, [connection]);
  useEffect(() => { setQuote(null); setPrepared(null); setSignature(null); setStatus(""); }, [action, asset, amount, owner]);

  async function getQuote() {
    if (!owner || !raw || !trade || !mainnet) return;
    setBusy(true); setPrepared(null); setStatus("Loading fresh Mainnet quote…");
    try {
      const query = new URLSearchParams({ action, asset, amount: raw, owner, slippageBps: "50" });
      const next = await api<Quote>(`/api/v2/exponent/quote?${query}`);
      if (next.owner !== owner || next.action !== action || next.asset !== asset || next.input.raw !== raw) throw new Error("Quote does not match request");
      setQuote(next); setStatus(next.previewOnly ? "Maturity preview only; redemption opens after 10 January 2027, 13:00 UTC." : "Quote loaded. Review output before preparing a transaction.");
    } catch (error) { setQuote(null); setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function prepare() {
    if (!owner || !mainnet || (action !== "setup" && !raw) || (trade && !currentQuote)) return;
    if (trade && currentQuote?.position === null) {
      setStatus("Set up the Exponent position first, then refresh this quote.");
      return;
    }
    setBusy(true); setPrepared(null); setStatus("Building and simulating an unsigned transaction…");
    try {
      const body = action === "setup" ? { action, owner }
        : trade ? { action, asset, amount: raw, owner, slippageBps: 50,
          minimumOutput: currentQuote!.output.minRaw, quotedAt: currentQuote!.chainTime }
          : { action, owner, amount: raw };
      const next = await api<Prepared>("/api/v2/exponent/transactions", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (next.requiredSigners.length !== 1 || next.requiredSigners[0] !== owner) throw new Error("Unexpected required signer");
      if (trade && (!next.quote || next.quote.owner !== owner || next.quote.action !== action || next.quote.asset !== asset
        || next.quote.input.raw !== raw || !next.minimumOutputRaw || BigInt(next.minimumOutputRaw) < BigInt(currentQuote!.output.minRaw))) {
        throw new Error("Prepared route differs from the accepted quote");
      }
      setPrepared({ ...next, intentKey });
      setStatus(next.executionReady && next.simulation.error === null
        ? "Simulation passed. Review the values below, then sign in your Solana wallet."
        : `Signing disabled: ${next.deploymentStatus}. Simulation: ${JSON.stringify(next.simulation.error)}.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function signAndSend() {
    if (!owner || !publicKey || !signTransaction || !currentPrepared?.executionReady || currentPrepared.simulation.error !== null || !mainnet) return;
    setBusy(true); setStatus("Checking transaction and asking wallet to sign…");
    try {
      if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("Wallet RPC is not Solana Mainnet");
      if (await connection.getBlockHeight("confirmed") > currentPrepared.lastValidBlockHeight) throw new Error("Blockhash expired; prepare again");
      if (currentPrepared.quote && Date.now() / 1000 >= currentPrepared.quote.expiresAt) throw new Error("Quote expired; refresh it");
      const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(currentPrepared.unsignedTransaction), (char) => char.charCodeAt(0)));
      if (!tx.message.staticAccountKeys[0].equals(publicKey) || tx.message.header.numRequiredSignatures !== 1) throw new Error("Unexpected fee payer or signer");
      const allowed = new Set([PROGRAM_ID.toBase58(), ComputeBudgetProgram.programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()]);
      const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex]?.toBase58());
      if (programs.some((program) => !program || !allowed.has(program)) || !programs.includes(PROGRAM_ID.toBase58())) {
        throw new Error("Unexpected transaction program");
      }
      const message = tx.message.serialize();
      const signed = await signTransaction(tx);
      if (!(signed instanceof VersionedTransaction) || signed.message.serialize().length !== message.length
        || signed.message.serialize().some((byte, index) => byte !== message[index])) {
        throw new Error("Wallet changed the transaction message");
      }
      const sent = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      setSignature(sent); setStatus(`Sent ${sent}. Waiting for confirmation…`);
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = (await connection.getSignatureStatuses([sent])).value[0];
        if (result?.err) throw new Error(`Transaction failed: ${JSON.stringify(result.err)}`);
        if (result?.confirmationStatus === "confirmed" || result?.confirmationStatus === "finalized") {
          setStatus(`Confirmed: ${sent}`); setPrepared(null); setQuote(null); return;
        }
        if (await connection.getBlockHeight("confirmed") > currentPrepared.lastValidBlockHeight) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setStatus(`Submitted: ${sent}. Confirmation is pending; inspect the signature before retrying.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-3xl space-y-5 p-5 text-sm">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">ONyc fixed income</h1>
        <p className="text-muted-foreground">PT-ONyc 10JAN27 · Solana Mainnet · <Link className="underline" href="/v2/safe">Back to Safe</Link></p></div>
      <WalletMultiButton />
    </header>
    <section className={card}>
      <p>Connect the Solana wallet that owns this Safe. Phantom and Solflare are supported. Deposit USDC into the Safe on the <Link href="/v2/safe" className="underline">Safe screen</Link> before buying from USDC.</p>
      <p className="text-muted-foreground">Buying: USDC or ONyc → PT in Safe. Early sale: PT → selected asset in your wallet. At maturity: redeem PT → selected asset in your wallet. Pilot performance fee: 0%.</p>
      {!mainnet && <p className="text-amber-200">Mainnet RPC check {genesis === null ? "pending or unavailable" : "failed"}; signing is disabled.</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1"><span className="block">Action</span><select className="w-full rounded-md border border-border bg-card p-2" value={action} disabled={busy} onChange={(event) => setAction(event.target.value as Action)}>
          <option value="setup">Set up position</option><option value="deposit_onyc">Deposit ONyc</option><option value="withdraw_onyc">Withdraw ONyc</option>
          <option value="buy">Buy PT</option><option value="sell">Sell PT early</option><option value="redeem">Redeem PT</option>
        </select></label>
        <label className="space-y-1"><span className="block">{action === "buy" ? "Input asset" : trade ? "Output asset" : "Asset"}</span>
          <select className="w-full rounded-md border border-border bg-card p-2" value={trade ? asset : "ONYC"} disabled={!trade || busy} onChange={(event) => setAsset(event.target.value as Asset)}>
            <option value="USDC">USDC</option><option value="ONYC">ONyc</option>
          </select></label>
        <label className="space-y-1"><span className="block">{action === "sell" || action === "redeem" ? "PT amount" : action === "setup" ? "Amount" : action === "buy" ? `${asset} amount` : "ONyc amount"}</span>
          <input className="w-full rounded-md border border-border bg-transparent p-2" inputMode="decimal" value={amount} disabled={action === "setup" || busy}
            placeholder={action === "setup" ? "Not needed" : "0.00"} onChange={(event) => setAmount(event.target.value)} /></label>
      </div>
      <div className="flex flex-wrap gap-2">
        {trade && <button className={button} type="button" disabled={busy || !owner || !mainnet || !raw} onClick={() => void getQuote()}>Get quote</button>}
        <button className={button} type="button" disabled={busy || !owner || !mainnet || (action !== "setup" && !raw) || (trade && (!currentQuote || currentQuote.previewOnly))}
          onClick={() => void prepare()}>Prepare unsigned transaction</button>
      </div>
    </section>
    {currentQuote && <section className={card}>
      <h2 className="text-lg font-semibold">Quote at slot {currentQuote.slot}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>Expected</dt><dd>{fromRaw(currentQuote.output.expectedRaw, action === "buy" ? 9 : asset === "USDC" ? 6 : 9)} {action === "buy" ? "PT" : asset}</dd>
        <dt>Minimum output</dt><dd>{fromRaw(currentQuote.output.minRaw, action === "buy" ? 9 : asset === "USDC" ? 6 : 9)} {action === "buy" ? "PT" : asset}</dd>
        <dt>Current ONyc NAV</dt><dd>{currentQuote.nav} USDC</dd>
        {currentQuote.position && <><dt>Tracked PT</dt><dd>{fromRaw(currentQuote.position.trackedPt, 9)} PT</dd>
          <dt>Remaining basis</dt><dd>{fromRaw(currentQuote.position.principalUsdc, 6)} USDC</dd></>}
        {currentQuote.lossFloorUsdc && <><dt>Executor loss floor</dt><dd>{fromRaw(currentQuote.lossFloorUsdc, 6)} USDC</dd></>}
      </dl>
      {currentQuote.maturityPreview && <p className="text-muted-foreground">At current NAV/liquidity: {fromRaw(currentQuote.maturityPreview.onycRaw, 9)} ONyc or {fromRaw(currentQuote.maturityPreview.usdcAtCurrentDexRaw, 6)} USDC. Future redemption value is unknown.</p>}
      {currentQuote.position === null && <p className="text-amber-200">This Safe has no Exponent position yet. Select <button className="underline" type="button" onClick={() => setAction("setup")}>Set up position</button>, prepare and sign it, then request a fresh quote.</p>}
      {currentQuote.previewOnly && <p className="text-amber-200">Redemption is unavailable until {new Date(MATURITY * 1000).toUTCString()}.</p>}
      {!currentQuote.executionReady && <p className="text-amber-200">The reviewed Safe upgrade is not deployed yet. Quote is read-only.</p>}
    </section>}
    {currentPrepared && <section className={card}>
      <h2 className="text-lg font-semibold">Transaction review</h2>
      <p>Wallet: {owner} · Network fee: {currentPrepared.networkFeeLamports ?? "unknown"} lamports · Simulation: {currentPrepared.simulation.error === null ? "passed" : "failed"} ({currentPrepared.simulation.unitsConsumed ?? "?"} CU).</p>
      {currentPrepared.quote && <p>Fresh expected: {fromRaw(currentPrepared.quote.output.expectedRaw, action === "buy" ? 9 : asset === "USDC" ? 6 : 9)} {action === "buy" ? "PT" : asset}; enforced minimum: {fromRaw(currentPrepared.minimumOutputRaw ?? currentPrepared.quote.output.minRaw, action === "buy" ? 9 : asset === "USDC" ? 6 : 9)}.</p>}
      <p className="text-muted-foreground">{currentPrepared.deploymentStatus}. Your wallet will show the final signature request. Rent for new token accounts may be additional.</p>
      <button className={`${button} bg-primary text-primary-foreground`} type="button" disabled={busy || !signTransaction || !currentPrepared.executionReady || currentPrepared.simulation.error !== null || !mainnet}
        onClick={() => void signAndSend()}>Sign in {wallet?.adapter.name ?? "Solana wallet"} and send</button>
    </section>}
    {(status || signature) && <section className={card} role="status"><p className="break-all">{status}</p>
      {signature && <a className="underline" target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${signature}`}>View transaction</a>}</section>}
  </main>;
}
