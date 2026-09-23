"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  Connection, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
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

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Mainnet MetaMask probe: one memo transaction, fee only, no token or SOL transfer. */
export function V2MainnetMemoProbe() {
  const connection = useMemo(() => typeof window === "undefined" ? null
    : new Connection(`${window.location.origin}/api/v2/mainnet-rpc`, "confirmed"), []);
  const { publicKey, wallet, signTransaction } = useWallet();
  const [mounted, setMounted] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!publicKey || !connection) return;
    let cancelled = false;
    connection.getBalance(publicKey, "confirmed")
      .then((lamports) => { if (!cancelled) setBalance(lamports); })
      .catch(() => { if (!cancelled) setBalance(null); });
    return () => { cancelled = true; };
  }, [connection, publicKey, refresh]);

  const canRun = mounted && !!connection && !!publicKey && !!signTransaction && balance !== null && balance >= MIN_BALANCE && !busy;

  async function run() {
    if (!canRun || !connection || !publicKey || !signTransaction) return;
    setBusy(true);
    const lines: string[] = [];
    const say = (line: string) => { lines.push(line); setLog(lines.join("\n")); };
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== MAINNET_GENESIS) throw new Error(`RPC genesis ${genesis} is not Solana Mainnet`);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const memo = `Yield AI v2 MetaMask mainnet probe; nonce=${crypto.randomUUID()}`;
      const tx = new VersionedTransaction(new TransactionMessage({
        payerKey: publicKey, recentBlockhash: blockhash,
        instructions: [new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo) })],
      }).compileToV0Message());
      const fee = (await connection.getFeeForMessage(tx.message, "confirmed")).value;
      const sim = await connection.simulateTransaction(tx, { sigVerify: false });
      if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}`);
      say(`Cluster: Solana Mainnet (genesis checked)\nFee payer: ${publicKey.toBase58()}\nProgram: Memo only, no transfers\nFee: ${fee ?? "?"} lamports\nMemo: ${memo}\nSimulation: ok\nWaiting for wallet signature...`);

      const signed = await signTransaction(tx);
      if (!sameBytes(signed.message.serialize(), tx.message.serialize())) throw new Error("wallet changed the transaction message");
      const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey.toBytes()).buffer, "Ed25519", false, ["verify"]);
      const ok = await crypto.subtle.verify("Ed25519", key,
        Uint8Array.from(signed.signatures[0]).buffer, Uint8Array.from(signed.message.serialize()).buffer);
      if (!ok) throw new Error("signature does not verify against the connected Solana address");
      say(`Signature verified locally (${wallet?.adapter.name}). Broadcasting...`);

      const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
      say(`Sent: ${signature}. Polling status...`);
      // Poll instead of confirmTransaction: the proxy has no websocket for signatureSubscribe.
      for (;;) {
        const status = (await connection.getSignatureStatuses([signature])).value[0];
        if (status?.err) throw new Error(`landed with error: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
        if (await connection.getBlockHeight("confirmed") > lastValidBlockHeight) throw new Error("blockhash expired before confirmation");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      say(`CONFIRMED on mainnet: ${signature}\nhttps://solscan.io/tx/${signature}\nSignature (base58): ${bs58.encode(signed.signatures[0])}`);
      setRefresh((value) => value + 1);
    } catch (error) {
      say(`FAILED or cancelled: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-2xl space-y-5 p-5 text-sm">
    <h1 className="text-2xl font-semibold">Yield AI v2 · MetaMask mainnet probe</h1>
    <p>Sends one Memo transaction on <strong>Solana Mainnet</strong>. Cost: network fee only (~0.000005 SOL). No SOL or token transfer. The wallet popup should say Solana Mainnet.</p>
    <WalletMultiButton />
    <dl className="grid gap-2 break-all">
      <div><dt>RPC</dt><dd>mainnet via local /api/v2/mainnet-rpc proxy</dd></div>
      <div><dt>Wallet</dt><dd>{mounted ? wallet?.adapter.name ?? "none" : "Detecting..."}</dd></div>
      <div><dt>Solana address</dt><dd>{mounted ? publicKey?.toBase58() ?? "connect a wallet" : "Detecting..."}</dd></div>
      <div><dt>Mainnet SOL balance</dt><dd>{balance === null ? "—" : `${balance / LAMPORTS_PER_SOL} SOL`} <button type="button" className="underline" onClick={() => setRefresh((value) => value + 1)}>Refresh</button></dd></div>
    </dl>
    {balance !== null && balance < MIN_BALANCE && <p className="text-amber-200">Needs at least 0.001 SOL on mainnet (fee + rent floor).</p>}
    <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!canRun} onClick={() => void run()}>
      {busy ? "Working..." : "Sign & send mainnet memo"}
    </button>
    <pre className="whitespace-pre-wrap break-all rounded border p-3">{log || "Nothing sent yet."}</pre>
  </main>;
}
