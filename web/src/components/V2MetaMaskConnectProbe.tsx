"use client";

import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { StandardWalletAdapter } from "@solana/wallet-adapter-base";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { RPC_URL } from "@/lib/constants";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_SCOPE = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

function sameBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Isolated MetaMask Connect probe. No transaction is broadcast. */
export function V2MetaMaskConnectProbe() {
  const { connection } = useConnection();
  const { wallet, publicKey } = useWallet();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const isMetaMask = wallet?.adapter.name.toLowerCase() === "metamask";
  const canProbe = isMetaMask && !!publicKey && RPC_URL.toLowerCase().includes("devnet") && !busy;

  async function signWithMetaMaskConnect() {
    if (!canProbe || !publicKey) return;
    setBusy(true);
    setResult("");
    try {
      const genesis = await connection.getGenesisHash();
      if (genesis !== DEVNET_GENESIS) throw new Error("RPC genesis is not Solana Devnet");
      const balance = await connection.getBalance(publicKey, "confirmed");
      if (balance < 1_000_000) throw new Error("fee payer needs at least 0.001 devnet SOL");
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const memo = `Yield AI v2 MetaMask Connect devnet signing probe; nonce=${crypto.randomUUID()}`;
      const memoIx = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(memo) });
      const transaction = new VersionedTransaction(new TransactionMessage({
        payerKey: publicKey, recentBlockhash: blockhash, instructions: [memoIx],
      }).compileToV0Message());
      const simulation = await connection.simulateTransaction(transaction, { sigVerify: false });
      if (simulation.value.err) throw new Error(`devnet simulation failed: ${JSON.stringify(simulation.value.err)}`);

      const { createSolanaClient } = await import("@metamask/connect-solana");
      const client = await createSolanaClient({
        dapp: { name: "Yield AI v2 devnet lab", url: window.location.origin },
        api: { supportedNetworks: { devnet: RPC_URL } },
        skipAutoRegister: true,
      });
      const sdkWallet = client.getWallet() as StandardWalletAdapter["wallet"];
      const { accounts } = await sdkWallet.features["standard:connect"].connect();
      const account = accounts.find((item) => item.address === publicKey.toBase58());
      if (!account) throw new Error("MetaMask Connect returned a different Solana account");
      if (!("solana:signTransaction" in sdkWallet.features)) throw new Error("MetaMask Connect has no signTransaction feature");
      const [{ signedTransaction }] = await sdkWallet.features["solana:signTransaction"].signTransaction({
        account, transaction: transaction.serialize(), chain: DEVNET_SCOPE,
      });
      const signed = VersionedTransaction.deserialize(signedTransaction);
      if (!sameBytes(signed.message.serialize(), transaction.message.serialize()))
        throw new Error("wallet changed the transaction message");
      if (!signed.signatures[0]?.some((byte) => byte !== 0)) throw new Error("wallet returned no payer signature");
      const key = await crypto.subtle.importKey("raw", Uint8Array.from(publicKey.toBytes()).buffer, "Ed25519", false, ["verify"]);
      const verified = await crypto.subtle.verify("Ed25519", key,
        Uint8Array.from(signed.signatures[0]).buffer, Uint8Array.from(signed.message.serialize()).buffer);
      if (!verified) throw new Error("v0 signature does not verify against the selected Solana address");
      setResult(`Verified MetaMask Connect v0 memo signature; NOT SENT.\nOwner and fee payer: ${publicKey.toBase58()}\nRPC genesis: ${genesis}\nRequested scope: ${DEVNET_SCOPE}\nMemo: ${memo}\nThe wallet popup must also have displayed Solana Devnet.`);
    } catch (error) {
      setResult(`MetaMask Connect probe failed or was cancelled: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded border border-amber-500 p-4">
    <h2 className="text-lg font-semibold">MetaMask Connect devnet probe</h2>
    <p>This uses MetaMask Connect with the official devnet scope. It signs a v0 memo and never broadcasts. Fee payer: selected Solana address; amount: 0 SOL; token: devnet SOL for network simulation; program: Memo.</p>
    <p className="text-amber-200">Confirm the popup says <strong>Solana Devnet</strong>. If it says Mainnet, cancel it and report the result.</p>
    <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!canProbe} onClick={() => void signWithMetaMaskConnect()}>
      {busy ? "Checking and requesting signature..." : "Sign via MetaMask Connect (no send)"}
    </button>
    {!isMetaMask && <p>Select MetaMask above to run this probe.</p>}
    {result && <pre className="whitespace-pre-wrap break-all">{result}</pre>}
  </section>;
}