"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { StandardWalletAdapter } from "@solana/wallet-adapter-base";

import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { RPC_URL } from "@/lib/constants";
import { V2MetaMaskConnectProbe } from "@/components/V2MetaMaskConnectProbe";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false },
);
const SolanaSignTransaction = "solana:signTransaction";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const V2_PROGRAM_ID = (() => {
  try {
    return process.env.NEXT_PUBLIC_V2_PROGRAM_ID
      ? new PublicKey(process.env.NEXT_PUBLIC_V2_PROGRAM_ID)
      : null;
  } catch { return null; }
})();

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Manual signing probe. It never submits a transaction or moves tokens. */
export function V2WalletLab() {
  const { connection } = useConnection();
  const { publicKey, wallet, wallets, signMessage } = useWallet();
  const [mounted, setMounted] = useState(false);
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  const [rpcGenesis, setRpcGenesis] = useState<string | null>(null);
  const [balanceLamports, setBalanceLamports] = useState<number | null>(null);
  const [balanceOwner, setBalanceOwner] = useState<string | null>(null);
  const [balanceError, setBalanceError] = useState("");
  const [balanceRefresh, setBalanceRefresh] = useState(0);
  useEffect(() => setMounted(true), []);

  const safe = useMemo(() => publicKey && V2_PROGRAM_ID
    ? PublicKey.findProgramAddressSync([Buffer.from("vault"), publicKey.toBuffer()], V2_PROGRAM_ID)[0].toBase58()
    : null, [publicKey]);
  const isDevnet = RPC_URL.toLowerCase().includes("devnet");
  const rpcHost = (() => { try { return new URL(RPC_URL).host; } catch { return "invalid RPC URL"; } })();
  useEffect(() => {
    if (!mounted || !publicKey || !isDevnet) return;
    let cancelled = false;
    Promise.all([connection.getGenesisHash(), connection.getBalance(publicKey, "confirmed")])
      .then(([genesis, lamports]) => {
        if (cancelled) return;
        setBalanceOwner(publicKey.toBase58());
        setRpcGenesis(genesis);
        setBalanceLamports(lamports);
        setBalanceError("");
      })
      .catch((error) => {
        if (cancelled) return;
        setRpcGenesis(null);
        setBalanceLamports(null);
        setBalanceError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [mounted, publicKey, connection, isDevnet, balanceRefresh]);
  const standardAdapter = wallet && "standard" in wallet.adapter && wallet.adapter.standard === true
    ? wallet.adapter as StandardWalletAdapter : null;
  const standardWallet = standardAdapter?.wallet;
  const account = standardWallet?.accounts.find((item) => item.address === publicKey?.toBase58());
  const accountChains = account?.chains ?? [];
  const walletChains = standardWallet?.chains ?? [];
  const supportsV0 = standardWallet && SolanaSignTransaction in standardWallet.features
    && standardWallet.features[SolanaSignTransaction].supportedTransactionVersions.includes(0);
  const supportsDevnet = Boolean(account && accountChains.includes("solana:devnet")
    && walletChains.includes("solana:devnet"));
  const isMetaMask = wallet?.adapter.name.toLowerCase() === "metamask";
  const currentBalance = balanceOwner === publicKey?.toBase58() ? balanceLamports : null;
  const currentGenesis = balanceOwner === publicKey?.toBase58() ? rpcGenesis : null;
  const hasFeeBalance = currentBalance !== null && currentBalance >= 1_000_000;
  const canSignDevnetMemo = mounted && isDevnet && currentGenesis === DEVNET_GENESIS
    && hasFeeBalance && supportsDevnet && supportsV0 && !isMetaMask && account?.features.includes(SolanaSignTransaction);

  async function signChallenge() {
    if (!mounted || !publicKey || !signMessage || !isDevnet) return;
    setBusy(true);
    setResult("");
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS) throw new Error("RPC genesis is not Solana Devnet");
      const challenge = ["Yield AI v2 Solana ownership probe", window.location.origin,
        `genesis:${genesis}`, `owner:${publicKey.toBase58()}`, `nonce:${crypto.randomUUID()}`].join("\n");
      const message = new TextEncoder().encode(challenge);
      const signature = await signMessage(message);
      const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey.toBytes()).buffer, "Ed25519", false, ["verify"]);
      const verified = await crypto.subtle.verify("Ed25519", key, Uint8Array.from(signature).buffer, Uint8Array.from(message).buffer);
      if (!verified) throw new Error("signature does not verify against the selected Solana address");
      setResult(`Verified Solana ownership signature (this does not prove devnet transaction support).\nMessage:\n${challenge}\n\nSignature (base58):\n${bs58.encode(signature)}`);
    } catch (error) {
      setResult(`Message signing failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  async function signMemoTransaction() {
    if (!canSignDevnetMemo || !standardWallet || !account || !publicKey) return;
    setBusy(true);
    setResult("");
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS) throw new Error("RPC genesis is not Solana Devnet");
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const memo = `Yield AI v2 signing probe; genesis=${genesis}; nonce=${crypto.randomUUID()}`;
      const memoIx = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo) });
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: publicKey, recentBlockhash: blockhash, instructions: [memoIx],
      }).compileToV0Message());
      if (!(SolanaSignTransaction in standardWallet.features)) throw new Error("wallet has no signTransaction feature");
      const signedResult = await standardWallet.features[SolanaSignTransaction].signTransaction({
        account, transaction: transaction.serialize(), chain: "solana:devnet",
      });
      const signed = VersionedTransaction.deserialize(signedResult[0].signedTransaction);
      if (!sameBytes(signed.message.serialize(), transaction.message.serialize()))
        throw new Error("wallet changed the transaction message");
      if (!signed.signatures[0]?.some((byte) => byte !== 0)) throw new Error("wallet returned no payer signature");
      const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey.toBytes()).buffer, "Ed25519", false, ["verify"]);
      const verified = await crypto.subtle.verify("Ed25519", key,
        Uint8Array.from(signed.signatures[0]).buffer, Uint8Array.from(signed.message.serialize()).buffer);
      if (!verified) throw new Error("v0 transaction signature does not verify against the selected Solana address");
      setResult(`Verified devnet v0 memo signature (not submitted).\nFee payer: ${publicKey.toBase58()}\n` +
        `Genesis: ${genesis}\nMemo: ${memo}\nSerialized bytes: ${signed.serialize().length}`);
    } catch (error) {
      setResult(`Transaction signing failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-2xl space-y-5 p-5 text-sm">
    <h1 className="text-2xl font-semibold">Yield AI v2 · wallet signing lab</h1>
    <p>Message signing proves control of the Solana address. It does not prove devnet transaction support. This page never broadcasts transactions.</p>
    <WalletMultiButton />
    <dl className="grid gap-2 break-all">
      <div><dt>Configured RPC host</dt><dd>{rpcHost}</dd></div>
      <div><dt>Detected wallets</dt><dd>{mounted ? [...new Set(wallets.map((item) => item.adapter.name))].join(", ") || "none" : "Detecting..."}</dd></div>
      <div><dt>Selected wallet</dt><dd>{mounted ? wallet?.adapter.name ?? "none" : "Detecting..."}</dd></div>
      <div><dt>Solana owner</dt><dd>{mounted ? publicKey?.toBase58() ?? "connect a wallet" : "Detecting..."}</dd></div>
      <div><dt>V2 program</dt><dd>{V2_PROGRAM_ID?.toBase58() ?? "not configured"}</dd></div>
      <div><dt>Derived Safe PDA</dt><dd>{mounted ? safe ?? "set NEXT_PUBLIC_V2_PROGRAM_ID and connect" : "Detecting..."}</dd></div>
      <div><dt>Wallet declared chains</dt><dd>{mounted ? accountChains.join(", ") || walletChains.join(", ") || "not available" : "Detecting..."}</dd></div>
      <div><dt>RPC genesis</dt><dd>{mounted ? currentGenesis ?? "checking..." : "Detecting..."}</dd></div>
      <div><dt>Devnet SOL balance</dt><dd>{mounted ? currentBalance === null ? "checking..." : `${currentBalance / 1_000_000_000} SOL` : "Detecting..."} <button type="button" className="underline" onClick={() => setBalanceRefresh((value) => value + 1)}>Refresh</button></dd></div>
      <div><dt>Capabilities</dt><dd>{mounted ? `signMessage: ${signMessage ? "yes" : "no"}; declared devnet: ${supportsDevnet ? "yes" : "no"}; v0: ${supportsV0 ? "yes" : "no"}` : "Detecting..."}</dd></div>
    </dl>
    {mounted && isMetaMask && <p className="rounded border border-amber-500 p-3 text-amber-200">
      MetaMask showed Solana Mainnet twice, including when this page explicitly requested solana:devnet. MetaMask transaction signing is disabled in this lab until its official devnet integration is verified. Ownership-message signing remains available. No transaction was sent.
    </p>}
    {mounted && currentBalance !== null && !hasFeeBalance && <p className="text-amber-200">This address has less than 0.001 devnet SOL. Fund the test address before the wallet simulation probe.</p>}
    {balanceError && <p className="text-red-300">Devnet RPC read failed: {balanceError}</p>}
    <div className="flex flex-wrap gap-3">
      <button className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!mounted || busy || !signMessage || !isDevnet} onClick={() => void signChallenge()}>Sign ownership challenge</button>
      <button className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!canSignDevnetMemo || busy} onClick={() => void signMemoTransaction()}>Sign devnet v0 memo</button>
    </div>
    <V2MetaMaskConnectProbe />
    {!isDevnet && <p className="text-red-300">Set NEXT_PUBLIC_RPC_URL to a devnet RPC before using this lab.</p>}
    <pre className="whitespace-pre-wrap break-all rounded border p-3">{result || "No signature requested yet."}</pre>
  </main>;
}