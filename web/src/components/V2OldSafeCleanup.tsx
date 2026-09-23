"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import type { StandardWalletAdapter } from "@solana/wallet-adapter-base";
import {
  ComputeBudgetProgram, Connection, LAMPORTS_PER_SOL, PublicKey, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createCloseAccountInstruction } from "@solana/spl-token";
import bs58 from "bs58";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false },
);
// Old mainnet program (HEAD build): no close/refund instructions, so empty ATAs are closed
// through the owner's execute_protocol_cpi with SPL CloseAccount signed by the Safe PDA.
const OLD_PROGRAM_ID = new PublicKey("3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s");
const EXECUTE_PROTOCOL_CPI = Uint8Array.from([255, 29, 92, 60, 105, 188, 32, 11]);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_CLOSES_PER_TX = 10;

type EmptyAccount = { pubkey: PublicKey; mint: string; programId: PublicKey; lamports: number };

function executeProtocolCpi(owner: PublicKey, vault: PublicKey, inner: TransactionInstruction) {
  const data = Buffer.alloc(8 + 4 + inner.data.length);
  data.set(EXECUTE_PROTOCOL_CPI, 0);
  data.writeUInt32LE(inner.data.length, 8);
  data.set(inner.data, 12);
  return new TransactionInstruction({
    programId: OLD_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: inner.programId, isSigner: false, isWritable: false },
      // The outer tx cannot sign for the PDA; the program re-marks it as signer via invoke_signed.
      ...inner.keys.map((key) => ({ ...key, isSigner: false })),
    ],
    data,
  });
}

export function V2OldSafeCleanup() {
  const connection = useMemo(() => typeof window === "undefined" ? null
    : new Connection(`${window.location.origin}/api/v2/mainnet-rpc`, "confirmed"), []);
  const { publicKey, wallet } = useWallet();
  const [mounted, setMounted] = useState(false);
  const [empty, setEmpty] = useState<EmptyAccount[]>([]);
  const [kept, setKept] = useState<string[]>([]);
  const [safeExists, setSafeExists] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  useEffect(() => setMounted(true), []);

  const vault = useMemo(() => publicKey
    ? PublicKey.findProgramAddressSync([Buffer.from("vault"), publicKey.toBuffer()], OLD_PROGRAM_ID)[0]
    : null, [publicKey]);

  const scan = useCallback(async () => {
    if (!connection || !vault) return;
    const info = await connection.getAccountInfo(vault, "confirmed");
    setSafeExists(!!info && info.owner.equals(OLD_PROGRAM_ID));
    if (!info) { setEmpty([]); setKept([]); return; }
    const found: EmptyAccount[] = [];
    const nonEmpty: string[] = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const res = await connection.getParsedTokenAccountsByOwner(vault, { programId }, "confirmed");
      for (const { pubkey, account } of res.value) {
        const parsed = (account.data as { parsed: { info: { mint: string; tokenAmount: { amount: string; uiAmountString: string } } } }).parsed.info;
        if (parsed.tokenAmount.amount === "0") found.push({ pubkey, mint: parsed.mint, programId, lamports: account.lamports });
        else nonEmpty.push(`${pubkey.toBase58()} (${parsed.tokenAmount.uiAmountString} of ${parsed.mint})`);
      }
    }
    setEmpty(found);
    setKept(nonEmpty);
  }, [connection, vault]);

  useEffect(() => { void scan().catch((error) => setLog(`scan failed: ${String(error)}`)); }, [scan]);

  const total = empty.reduce((sum, item) => sum + item.lamports, 0);

  async function closeAll() {
    if (!connection || !publicKey || !vault || empty.length === 0) return;
    setBusy(true);
    const lines: string[] = [];
    const say = (line: string) => { lines.push(line); setLog(lines.join("\n")); };
    try {
      if (await connection.getGenesisHash() !== MAINNET_GENESIS) throw new Error("RPC is not Solana Mainnet");
      const adapter = wallet?.adapter as StandardWalletAdapter | undefined;
      const standard = adapter && "standard" in adapter && adapter.standard ? adapter.wallet : null;
      const account = standard?.accounts.find((item) => item.address === publicKey.toBase58());
      const feature = (standard?.features as Record<string, unknown> | undefined)?.["solana:signAndSendTransaction"] as
        { signAndSendTransaction: (...inputs: { account: typeof account; transaction: Uint8Array; chain: string }[]) => Promise<{ signature: Uint8Array }[]> } | undefined;
      if (!account || !feature) throw new Error("wallet has no Wallet Standard signAndSendTransaction");

      for (let start = 0; start < empty.length; start += MAX_CLOSES_PER_TX) {
        const batch = empty.slice(start, start + MAX_CLOSES_PER_TX);
        const ixs = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 + 25_000 * batch.length }),
          ...batch.map((item) => executeProtocolCpi(publicKey, vault,
            createCloseAccountInstruction(item.pubkey, publicKey, vault, [], item.programId))),
        ];
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new VersionedTransaction(new TransactionMessage({
          payerKey: publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
        const sim = await connection.simulateTransaction(tx, { sigVerify: false });
        if (sim.value.err) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-8).join("\n")}`);
        say(`Batch ${start / MAX_CLOSES_PER_TX + 1}: close ${batch.length} empty accounts of Safe ${vault.toBase58()}; rent -> ${publicKey.toBase58()}. Simulation ok (${sim.value.unitsConsumed} CU). Waiting for wallet...`);
        const [output] = await feature.signAndSendTransaction({ account, transaction: tx.serialize(), chain: "solana:mainnet" });
        const signature = bs58.encode(output.signature);
        say(`Sent ${signature}. Polling...`);
        for (;;) {
          const status = (await connection.getSignatureStatuses([signature])).value[0];
          if (status?.err) throw new Error(`landed with error: ${JSON.stringify(status.err)}`);
          if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") break;
          if (await connection.getBlockHeight("confirmed") > lastValidBlockHeight) throw new Error("blockhash expired");
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        say(`CONFIRMED https://solscan.io/tx/${signature}`);
      }
      await scan();
    } catch (error) {
      say(`FAILED or cancelled: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  return <main className="mx-auto max-w-2xl space-y-5 p-5 text-sm">
    <h1 className="text-2xl font-semibold">Old Safe cleanup · close empty token accounts</h1>
    <p>Mainnet, old program <code>{OLD_PROGRAM_ID.toBase58()}</code>. Connect the Safe <strong>owner</strong> wallet. Only token accounts with a zero balance are closed; their rent returns to the owner. Accounts holding anything (e.g. a lending position NFT) are left untouched.</p>
    <WalletMultiButton />
    <dl className="grid gap-2 break-all">
      <div><dt>Owner</dt><dd>{mounted ? publicKey?.toBase58() ?? "connect a wallet" : "Detecting..."}</dd></div>
      <div><dt>Safe PDA</dt><dd>{vault?.toBase58() ?? "—"} {safeExists === false && "(no Safe for this owner)"}</dd></div>
      <div><dt>Empty accounts to close</dt><dd>{empty.length} · rent {(total / LAMPORTS_PER_SOL).toFixed(6)} SOL</dd></div>
    </dl>
    {empty.length > 0 && <ul className="list-disc pl-5 break-all">{empty.map((item) =>
      <li key={item.pubkey.toBase58()}>{item.pubkey.toBase58()} · mint {item.mint} · {item.programId.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL Token"}</li>)}</ul>}
    {kept.length > 0 && <div><p>Kept (non-zero):</p><ul className="list-disc pl-5 break-all">{kept.map((item) => <li key={item}>{item}</li>)}</ul></div>}
    <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={busy || !publicKey || empty.length === 0} onClick={() => void closeAll()}>
      {busy ? "Working..." : `Close ${empty.length} empty accounts`}
    </button>
    <pre className="whitespace-pre-wrap break-all rounded border p-3">{log || "Nothing sent yet."}</pre>
  </main>;
}
