"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import { createWalletClient, custom, formatUnits, parseUnits, type EIP1193Provider, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import {
  CCTP_TESTNET, FORWARD_HOOK, ZERO_BYTES32, erc20Abi, messengerAbi, sourceClient,
  fetchFeeQuote, inspectSourceBurn, isTxHash, maxFeeRaw, mintRecipientBytes32,
  readJournal, refreshTransfer, saveJournal, validateRecipient,
  type BridgeTransfer, type FeeQuote, type Recipient,
} from "@/lib/v2CctpEngine";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false },
);
type Eip6963Detail = { info: { rdns: string }; provider: EIP1193Provider };

/** Phantom also injects window.ethereum, so select MetaMask by EIP-6963 identity. */
function findMetaMask(): Promise<EIP1193Provider | null> {
  return new Promise((resolve) => {
    let found: EIP1193Provider | null = null;
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail;
      if (detail?.info?.rdns === "io.metamask") found = detail.provider;
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => { window.removeEventListener("eip6963:announceProvider", onAnnounce); resolve(found); }, 400);
  });
}

export function V2CctpProbe() {
  // Read-only Solana Devnet connection; the rest of the app can remain on Mainnet.
  const connection = useMemo(() => new Connection(
    process.env.NEXT_PUBLIC_V2_CCTP_DEVNET_RPC_URL || "https://api.devnet.solana.com", "confirmed",
  ), []);
  const { publicKey } = useWallet();
  const ownerRef = useRef(publicKey?.toBase58());
  ownerRef.current = publicKey?.toBase58();
  const [recipient, setRecipient] = useState<Recipient | null>(null);
  const [recipientError, setRecipientError] = useState("");
  const [evm, setEvm] = useState<{ provider: EIP1193Provider; address: Hex } | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("2");
  const [quote, setQuote] = useState<FeeQuote | null>(null);
  const [journal, setJournal] = useState<BridgeTransfer[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [importHash, setImportHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState("");
  const [log, setLog] = useState("");

  function record(transfer: BridgeTransfer) {
    try { setJournal(saveJournal(localStorage, transfer)); }
    catch {
      setJournal((current) => [transfer, ...current.filter((item) => item.sourceTxHash !== transfer.sourceTxHash)]);
      setLog(`Browser storage unavailable. Save the Base Sepolia tx hash to resume: ${transfer.sourceTxHash}`);
    }
    setSelectedHash(transfer.sourceTxHash);
  }

  useEffect(() => {
    setJournal(readJournal(localStorage));
    void fetchFeeQuote().then(setQuote).catch((error) => setLog(`Circle quote failed: ${String(error)}`));
  }, []);

  useEffect(() => {
    setRecipient(null);
    setRecipientError("");
    if (!publicKey) return;
    let cancelled = false;
    void validateRecipient(connection, publicKey).then((value) => {
      if (!cancelled) setRecipient(value);
    }).catch((error) => {
      if (!cancelled) setRecipientError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [connection, publicKey]);

  const transfers = journal.filter((item) => recipient && item.owner === recipient.owner &&
    item.safe === recipient.safe && item.ata === recipient.ata);
  const active = transfers.find((item) => item.sourceTxHash === selectedHash) ?? transfers[0];
  const pending = transfers.some((item) => !["settled", "source_failed", "destination_failed"].includes(item.stage));

  useEffect(() => {
    if (!recipient || !active || ["settled", "source_failed", "destination_failed"].includes(active.stage)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current = active;
    const tick = async () => {
      try {
        const verified = await validateRecipient(connection, new PublicKey(recipient.owner));
        if (verified.safe !== current.safe || verified.ata !== current.ata) throw new Error("Safe recipient changed");
        const next = await refreshTransfer(connection, current);
        if (!stopped) {
          const previous = current;
          current = next;
          setStatusError("");
          if (next.stage !== previous.stage || next.forwardTxHash !== previous.forwardTxHash ||
            next.messageHash !== previous.messageHash || next.forwardState !== previous.forwardState ||
            next.circleStatus !== previous.circleStatus) record(next);
          if (next.stage === "settled" && previous.stage !== "settled") {
            void validateRecipient(connection, new PublicKey(recipient.owner)).then(setRecipient).catch(() => undefined);
          }
        }
      } catch (error) {
        if (!stopped) setStatusError(error instanceof Error ? error.message : String(error));
      }
      if (!stopped && !["settled", "source_failed", "destination_failed"].includes(current.stage)) timer = setTimeout(() => void tick(), 10000);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
    // Re-run only for another selected transaction/owner; tick keeps its own latest state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sourceTxHash, recipient?.ata, connection]);

  let amountRaw = BigInt(0);
  let ceiling: bigint | null = null;
  try {
    amountRaw = parseUnits(amount || "0", 6);
    if (quote && amountRaw > BigInt(0)) ceiling = maxFeeRaw(amountRaw, quote);
  } catch { /* Invalid input disables burn. */ }

  async function connectEvm() {
    setBusy(true);
    try {
      const provider = await findMetaMask();
      if (!provider) throw new Error("MetaMask (EIP-6963 io.metamask) not found");
      await provider.request({ method: "eth_requestAccounts" });
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
      } catch {
        await provider.request({ method: "wallet_addEthereumChain", params: [{
          chainId: "0x14a34", chainName: "Base Sepolia", rpcUrls: ["https://sepolia.base.org"],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.basescan.org"],
        }] });
      }
      const [address] = await provider.request({ method: "eth_accounts" }) as Hex[];
      if (!address) throw new Error("No MetaMask EVM account selected");
      if (Number(await provider.request({ method: "eth_chainId" })) !== baseSepolia.id) throw new Error("MetaMask is not on Base Sepolia");
      setEvm({ provider, address });
      setUsdc(await sourceClient.readContract({ address: CCTP_TESTNET.sourceUsdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }));
    } catch (error) { setLog(`EVM connect failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  async function checkWallet(provider: EIP1193Provider, expected: Hex) {
    const [address] = await provider.request({ method: "eth_accounts" }) as Hex[];
    if (address?.toLowerCase() !== expected.toLowerCase()) throw new Error("MetaMask EVM account changed; reconnect before burn");
    if (Number(await provider.request({ method: "eth_chainId" })) !== baseSepolia.id) throw new Error("MetaMask is not on Base Sepolia");
  }

  async function burnToSafe() {
    if (!evm || !recipient || !publicKey || !quote || ceiling === null || amountRaw <= ceiling || pending) return;
    setBusy(true);
    setLog("");
    try {
      const owner = publicKey.toBase58();
      const verified = await validateRecipient(connection, publicKey);
      if (verified.ata !== recipient.ata || ownerRef.current !== owner) throw new Error("Solana owner or Safe changed; review recipient again");
      await checkWallet(evm.provider, evm.address);
      // A lower quote is welcome; an increased ceiling needs fresh user review.
      const fresh = await fetchFeeQuote();
      setQuote(fresh);
      if (maxFeeRaw(amountRaw, fresh) > ceiling) throw new Error("Circle fee increased. Review the new maximum fee, then click again.");
      const wallet = createWalletClient({ chain: baseSepolia, transport: custom(evm.provider), account: evm.address });
      const allowance = await sourceClient.readContract({
        address: CCTP_TESTNET.sourceUsdc, abi: erc20Abi, functionName: "allowance",
        args: [evm.address, CCTP_TESTNET.tokenMessenger],
      });
      if (allowance < amountRaw) {
        setLog(`Approve ${formatUnits(amountRaw, 6)} test USDC for Circle...`);
        await sourceClient.simulateContract({
          account: evm.address, address: CCTP_TESTNET.sourceUsdc, abi: erc20Abi,
          functionName: "approve", args: [CCTP_TESTNET.tokenMessenger, amountRaw],
        });
        const approvalHash = await wallet.writeContract({
          address: CCTP_TESTNET.sourceUsdc, abi: erc20Abi, functionName: "approve",
          args: [CCTP_TESTNET.tokenMessenger, amountRaw],
        });
        const approval = await sourceClient.waitForTransactionReceipt({ hash: approvalHash });
        if (approval.status !== "success") throw new Error(`USDC approval reverted: ${approvalHash}`);
        setLog(`Approval confirmed: ${approvalHash}`);
      }
      await checkWallet(evm.provider, evm.address);
      const currentBalance = await sourceClient.readContract({
        address: CCTP_TESTNET.sourceUsdc, abi: erc20Abi, functionName: "balanceOf", args: [evm.address],
      });
      setUsdc(currentBalance);
      if (currentBalance < amountRaw) throw new Error("Base Sepolia USDC balance fell below the burn amount");
      const rechecked = await validateRecipient(connection, publicKey);
      if (rechecked.ata !== recipient.ata || ownerRef.current !== owner) throw new Error("Solana owner or Safe changed before burn");
      const requote = await fetchFeeQuote();
      setQuote(requote);
      if (maxFeeRaw(amountRaw, requote) > ceiling) throw new Error("Circle fee increased after approval. Review and retry burn.");
      const fee = maxFeeRaw(amountRaw, requote);
      if (amountRaw <= fee) throw new Error("Amount does not cover the current Circle fee ceiling");
      const burnArgs = [amountRaw, CCTP_TESTNET.destinationDomain, mintRecipientBytes32(recipient.ata),
        CCTP_TESTNET.sourceUsdc, ZERO_BYTES32, fee, CCTP_TESTNET.finalityThreshold, FORWARD_HOOK] as const;
      await sourceClient.simulateContract({
        account: evm.address, address: CCTP_TESTNET.tokenMessenger, abi: messengerAbi,
        functionName: "depositForBurnWithHook", args: burnArgs,
      });
      setLog(`Burn ${formatUnits(amountRaw, 6)} test USDC to Safe ATA ${recipient.ata}; maxFee ${formatUnits(fee, 6)} USDC. Waiting for MetaMask...`);
      const hash = await wallet.writeContract({
        address: CCTP_TESTNET.tokenMessenger, abi: messengerAbi, functionName: "depositForBurnWithHook",
        args: burnArgs,
      });
      // Persist immediately after MetaMask returns the hash, before waiting for a receipt.
      const transfer: BridgeTransfer = {
        version: 1, sourceTxHash: hash, sourceAddress: evm.address, owner: recipient.owner,
        safe: recipient.safe, ata: recipient.ata, amountRaw: amountRaw.toString(), maxFeeRaw: fee.toString(),
        startedAt: Date.now(), stage: "source_pending",
      };
      record(transfer);
      setLog(`Burn submitted: ${hash}. Circle and Solana will be checked until the mint is finalized.`);
    } catch (error) {
      setLog(`Stopped: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  async function importTransfer() {
    if (!recipient || !isTxHash(importHash.trim())) return;
    setBusy(true);
    try {
      const verified = await validateRecipient(connection, new PublicKey(recipient.owner));
      if (verified.ata !== recipient.ata) throw new Error("Safe recipient changed");
      const transfer = await inspectSourceBurn(importHash.trim() as Hex, verified);
      record(transfer);
      setImportHash("");
      setLog(`Recovered burn ${transfer.sourceTxHash} from Base Sepolia. Tracking Circle delivery.`);
    } catch (error) { setLog(`Recovery failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  const canBurn = !!evm && !!recipient && !!quote && ceiling !== null && amountRaw > ceiling &&
    usdc !== null && usdc >= amountRaw && !pending && !busy;

  return <main className="mx-auto max-w-2xl space-y-5 p-5 text-sm">
    <h1 className="text-2xl font-semibold">Yield AI v2 · CCTP to Safe (Devnet)</h1>
    <p>Base Sepolia test USDC → Solana Devnet Safe. Circle forwards the mint to the Safe&apos;s USDC account. Each EVM transaction requires your MetaMask confirmation.</p>
    <div className="space-y-2 rounded border p-3">
      <div>Solana Safe owner <WalletMultiButton /></div>
      <div className="break-all">Owner: {publicKey?.toBase58() ?? "connect a Solana wallet"}</div>
      <div className="break-all">Safe: {recipient?.safe ?? "—"}</div>
      <div className="break-all">USDC recipient ATA: {recipient?.ata ?? "—"}</div>
      <p className={recipient ? "text-green-300" : "text-amber-200"}>{recipient ? "Recipient verified on Solana Devnet" : recipientError || "Connect the wallet that owns an existing Devnet v2 Safe."}</p>
    </div>
    <label className="block">Amount to burn (test USDC, including Circle fees)
      <input className="mt-1 w-36 rounded border bg-transparent p-2" value={amount} onChange={(event) => setAmount(event.target.value)} />
    </label>
    <dl className="grid gap-2 break-all">
      <div><dt>Circle live fast quote</dt><dd>{quote ? `${quote.protocolBps} bps + ${formatUnits(quote.forwardRaw, 6)} USDC forwarding` : "loading"}</dd></div>
      <div><dt>Maximum Circle fee</dt><dd>{ceiling !== null ? `${formatUnits(ceiling, 6)} USDC (ceiling, actual may be less)` : "—"}</dd></div>
      <div><dt>Minimum received</dt><dd>{ceiling !== null && amountRaw > ceiling ? `${formatUnits(amountRaw - ceiling, 6)} USDC` : "amount must exceed fees"}</dd></div>
      <div><dt>Base Sepolia source</dt><dd>{evm ? `${evm.address} · ${usdc === null ? "?" : formatUnits(usdc, 6)} test USDC` : "connect MetaMask"}</dd></div>
      <div><dt>Safe USDC balance</dt><dd>{recipient ? `${formatUnits(recipient.balanceRaw, 6)} USDC at recipient check` : "—"}</dd></div>
    </dl>
    <div className="flex flex-wrap gap-3">
      <button type="button" className="rounded border px-3 py-2 disabled:opacity-40" disabled={busy} onClick={() => {
        void fetchFeeQuote().then(setQuote).catch((error) => setLog(`Circle quote failed: ${String(error)}`));
      }}>Refresh Circle quote</button>
      <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={busy} onClick={() => void connectEvm()}>Connect MetaMask (Base Sepolia)</button>
      <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!canBurn} onClick={() => void burnToSafe()}>Approve + burn to Safe</button>
    </div>
    {pending && <p className="text-amber-200">Finish tracking the pending burn before starting another one to this Safe.</p>}
    <section className="space-y-2 rounded border p-3">
      <h2 className="font-semibold">Recover a burn</h2>
      <p>On another device, connect the same Solana Safe owner and paste the Base Sepolia burn tx hash. The transaction is decoded and checked against this Safe before tracking.</p>
      <input className="w-full rounded border bg-transparent p-2 font-mono" placeholder="0x… Base Sepolia tx hash" value={importHash} onChange={(event) => setImportHash(event.target.value)} />
      <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={busy || !recipient || !isTxHash(importHash.trim())} onClick={() => void importTransfer()}>Track this burn</button>
    </section>
    {transfers.length > 0 && <section className="space-y-3 rounded border p-3">
      <h2 className="font-semibold">Bridge journal</h2>
      <div className="flex flex-wrap gap-2">{transfers.map((item) => <button key={item.sourceTxHash} type="button" className={`rounded border px-2 py-1 ${active?.sourceTxHash === item.sourceTxHash ? "border-white" : "border-gray-600"}`} onClick={() => setSelectedHash(item.sourceTxHash)}>{item.sourceTxHash.slice(0, 10)} · {item.stage}</button>)}</div>
      {active && <div className="space-y-1 break-all">
        <p>Source: <a className="underline" href={`https://sepolia.basescan.org/tx/${active.sourceTxHash}`} target="_blank" rel="noreferrer">{active.sourceTxHash}</a></p>
        <p>Amount: {formatUnits(BigInt(active.amountRaw), 6)} USDC · recipient {active.ata}</p>
        <p>Status: {active.stage}{active.circleStatus ? ` · Circle ${active.circleStatus}` : ""}{active.forwardState ? ` · relay ${active.forwardState}` : ""}{active.messageHash ? ` · message ${active.messageHash}` : ""}</p>
        {active.forwardTxHash && <p>Solana mint: <a className="underline" href={`https://solscan.io/tx/${active.forwardTxHash}?cluster=devnet`} target="_blank" rel="noreferrer">{active.forwardTxHash}</a></p>}
        {active.receivedRaw && <p>Verified minted amount: {formatUnits(BigInt(active.receivedRaw), 6)} USDC</p>}
        {statusError && <p className="text-amber-200">Tracking: {statusError}</p>}
      </div>}
    </section>}
    <pre className="whitespace-pre-wrap break-all rounded border p-3">{log || "No action yet."}</pre>
  </main>;
}
