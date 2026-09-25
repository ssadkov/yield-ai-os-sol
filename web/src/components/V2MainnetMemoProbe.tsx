"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import type { StandardWalletAdapter } from "@solana/wallet-adapter-base";
import {
  Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false },
);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
// Fee plus the rent-exempt floor of an empty system account (~0.00089 SOL).
const MIN_BALANCE = 1_000_000;
const RENT_FLOOR = 890_880;
const MAX_TRANSFER_SOL = 0.002;

type Kind = "memo" | "transfer";
type Format = "v0" | "legacy";

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Wallet adapter errors wrap the wallet's own error; surface every layer. */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) parts.push(`${current.name}: ${current.message || "(no message)"}`);
    else if (typeof current === "object") parts.push(JSON.stringify(current));
    else parts.push(String(current));
    const next = current as { error?: unknown; cause?: unknown; data?: unknown };
    current = next.error ?? next.cause ?? (typeof next.data === "object" ? next.data : undefined);
  }
  return parts.join("\n  <- ");
}

/** Mainnet MetaMask probe: one Memo or small SOL transfer, signed by the connected wallet. */
export function V2MainnetMemoProbe() {
  const connection = useMemo(() => typeof window === "undefined" ? null
    : new Connection(`${window.location.origin}/api/v2/mainnet-rpc`, "confirmed"), []);
  const { publicKey, wallet, signTransaction } = useWallet();
  const [mounted, setMounted] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [kind, setKind] = useState<Kind>("memo");
  const [format, setFormat] = useState<Format>("v0");
  const [recipient, setRecipient] = useState("EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
  const [amountSol, setAmountSol] = useState("0.001");
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!publicKey || !connection) return;
    let cancelled = false;
    connection.getBalance(publicKey, "confirmed")
      .then((lamports) => { if (!cancelled) setBalance(lamports); })
      .catch(() => { if (!cancelled) setBalance(null); });
    return () => { cancelled = true; };
  }, [connection, publicKey, refresh]);

  const lamports = Math.round(Number(amountSol) * LAMPORTS_PER_SOL);
  const transferValid = kind === "memo" || (Number.isFinite(lamports) && lamports > 0
    && Number(amountSol) <= MAX_TRANSFER_SOL && (() => { try { new PublicKey(recipient); return true; } catch { return false; } })());
  const canRun = mounted && !!connection && !!publicKey && !!signTransaction && balance !== null
    && balance >= MIN_BALANCE && transferValid && !busy;

  async function run(mode: "sign" | "signAndSend") {
    if (!canRun || !connection || !publicKey || !signTransaction) return;
    setBusy(true);
    const lines: string[] = [];
    const say = (line: string) => { lines.push(line); setLog(lines.join("\n")); };
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== MAINNET_GENESIS) throw new Error(`RPC genesis ${genesis} is not Solana Mainnet`);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const instruction = kind === "memo"
        ? new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [],
          data: Buffer.from(`Yield AI v2 MetaMask mainnet probe; nonce=${crypto.randomUUID()}`) })
        : SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(recipient), lamports });
      if (kind === "transfer" && balance !== null && balance - lamports - 5_000 < RENT_FLOOR) {
        throw new Error("transfer would leave the sender below the rent-exempt floor");
      }
      const tx: Transaction | VersionedTransaction = format === "v0"
        ? new VersionedTransaction(new TransactionMessage({
          payerKey: publicKey, recentBlockhash: blockhash, instructions: [instruction] }).compileToV0Message())
        : new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(instruction);
      const message = tx instanceof VersionedTransaction ? tx.message : tx.compileMessage();
      const fee = (await connection.getFeeForMessage(message, "confirmed")).value;
      const sim = tx instanceof VersionedTransaction
        ? await connection.simulateTransaction(tx, { sigVerify: false })
        : await connection.simulateTransaction(tx);
      if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
      say(`Cluster: Solana Mainnet (genesis checked)\nFee payer: ${publicKey.toBase58()}\n` +
        (kind === "memo" ? "Instruction: Memo, no transfers" : `Instruction: transfer ${amountSol} SOL to ${recipient}`) +
        `\nFormat: ${format}; mode: ${mode}\nFee: ${fee ?? "?"} lamports\nSimulation: ok\nWaiting for wallet...`);

      let signature: string;
      let signerNote = "";
      if (mode === "signAndSend") {
        // Wallet signs and broadcasts through its own RPC. Called directly: the adapter's sendTransaction
        // derives the chain from the RPC URL and our 127.0.0.1 proxy maps to solana:localnet.
        const adapter = wallet?.adapter as StandardWalletAdapter | undefined;
        const standard = adapter && "standard" in adapter && adapter.standard ? adapter.wallet : null;
        const account = standard?.accounts.find((item) => item.address === publicKey.toBase58());
        const feature = (standard?.features as Record<string, unknown> | undefined)?.["solana:signAndSendTransaction"] as
          { signAndSendTransaction: (...inputs: { account: typeof account; transaction: Uint8Array; chain: string }[]) => Promise<{ signature: Uint8Array }[]> } | undefined;
        if (!standard || !account || !feature) throw new Error("wallet has no Wallet Standard signAndSendTransaction");
        const serialized = tx instanceof VersionedTransaction ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
        const [output] = await feature.signAndSendTransaction({ account, transaction: serialized, chain: "solana:mainnet" });
        signature = bs58.encode(output.signature);
        say(`Wallet returned signature ${signature}. Polling status...`);
      } else {
        const signed = await signTransaction(tx);
        const messageBytes = signed instanceof VersionedTransaction ? signed.message.serialize() : signed.serializeMessage();
        const expected = tx instanceof VersionedTransaction ? tx.message.serialize() : tx.serializeMessage();
        const payerSignature = signed instanceof VersionedTransaction ? signed.signatures[0] : signed.signatures[0]?.signature;
        if (!payerSignature) throw new Error("wallet returned no payer signature");
        if (!sameBytes(messageBytes, expected)) throw new Error("wallet changed the transaction message");
        const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey.toBytes()).buffer, "Ed25519", false, ["verify"]);
        const ok = await crypto.subtle.verify("Ed25519", key, Uint8Array.from(payerSignature).buffer, Uint8Array.from(messageBytes).buffer);
        if (!ok) throw new Error("signature does not verify against the connected Solana address");
        say(`Signature verified locally (${wallet?.adapter.name}). Broadcasting...`);
        signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
        signerNote = `\nSignature (base58): ${bs58.encode(payerSignature)}`;
        say(`Sent: ${signature}. Polling status...`);
      }
      // Poll instead of confirmTransaction: the proxy has no websocket for signatureSubscribe.
      for (;;) {
        const status = (await connection.getSignatureStatuses([signature])).value[0];
        if (status?.err) throw new Error(`landed with error: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
        if (await connection.getBlockHeight("confirmed") > lastValidBlockHeight) throw new Error("blockhash expired before confirmation");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      say(`CONFIRMED on mainnet (${kind}, ${format}, ${mode}): ${signature}\nhttps://solscan.io/tx/${signature}${signerNote}`);
      setRefresh((value) => value + 1);
    } catch (error) {
      say(`FAILED or cancelled:\n  ${describeError(error)}`);
    } finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-2xl space-y-5 p-5 text-sm">
    <h1 className="text-2xl font-semibold">Yield AI v2 · MetaMask mainnet probe</h1>
    <p>One transaction on <strong>Solana Mainnet</strong>: either a Memo (fee only) or a small SOL transfer (max {MAX_TRANSFER_SOL} SOL). The wallet popup should say Solana Mainnet.</p>
    <WalletMultiButton />
    <dl className="grid gap-2 break-all">
      <div><dt>RPC</dt><dd>mainnet via local /api/v2/mainnet-rpc proxy</dd></div>
      <div><dt>Wallet</dt><dd>{mounted ? wallet?.adapter.name ?? "none" : "Detecting..."}</dd></div>
      <div><dt>Solana address</dt><dd>{mounted ? publicKey?.toBase58() ?? "connect a wallet" : "Detecting..."}</dd></div>
      <div><dt>Mainnet SOL balance</dt><dd>{balance === null ? "—" : `${balance / LAMPORTS_PER_SOL} SOL`} <button type="button" className="underline" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></dd></div>
    </dl>
    <div className="flex flex-wrap gap-4">
      <label>Instruction{" "}
        <select className="rounded border bg-transparent p-1" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          <option value="memo">Memo</option><option value="transfer">SOL transfer</option>
        </select>
      </label>
      <label>Format{" "}
        <select className="rounded border bg-transparent p-1" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
          <option value="v0">v0</option><option value="legacy">legacy</option>
        </select>
      </label>
    </div>
    {kind === "transfer" && <div className="space-y-2">
      <label className="block">Recipient
        <input className="mt-1 w-full rounded border bg-transparent p-2 font-mono" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} />
      </label>
      <label className="block">Amount, SOL (max {MAX_TRANSFER_SOL})
        <input className="mt-1 w-32 rounded border bg-transparent p-2" value={amountSol} onChange={(e) => setAmountSol(e.target.value)} />
      </label>
    </div>}
    {balance !== null && balance < MIN_BALANCE && <p className="text-amber-200">Needs at least 0.001 SOL on mainnet (fee + rent floor).</p>}
    <div className="flex flex-wrap gap-3">
      <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!canRun} onClick={() => void run("sign")}>
        {busy ? "Working..." : "A: signTransaction, page sends"}
      </button>
      <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!canRun} onClick={() => void run("signAndSend")}>
        {busy ? "Working..." : "B: wallet signs and sends"}
      </button>
    </div>
    <p>If the wallet popup hangs after Confirm, reload this page; nothing is sent unless a signature returns.</p>
    <pre className="whitespace-pre-wrap break-all rounded border p-3">{log || "Nothing sent yet."}</pre>
  </main>;
}
