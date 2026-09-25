"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import {
  createPublicClient, createWalletClient, custom, http, parseAbi, formatUnits, parseUnits,
  type EIP1193Provider, type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";

// Circle CCTP V2 testnet values: developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const SOURCE_DOMAIN = 6; // Base Sepolia
const SOLANA_DOMAIN = 5;
const FAST_FINALITY = 1000;
// "cctp-forward" magic, version 0, no payload: the Safe ATA already exists, so no ATA creation.
const FORWARD_HOOK: Hex = "0x636374702d666f72776172640000000000000000000000000000000000000000";
const IRIS = "https://iris-api-sandbox.circle.com";
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const V2_PROGRAM_ID = process.env.NEXT_PUBLIC_V2_PROGRAM_ID || "8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5";
const STORAGE_KEY = "yield-v2-cctp-burn";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const messenger = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });

type Eip6963Detail = { info: { rdns: string; name: string }; provider: EIP1193Provider };

/** Phantom also injects window.ethereum, so select MetaMask explicitly via EIP-6963. */
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

type Burn = { txHash: Hex; ata: string; amount: string; startedAt: number };

export function V2CctpProbe() {
  const { connection } = useConnection();
  const [ataInput, setAtaInput] = useState("");
  const [amount, setAmount] = useState("2");
  const [check, setCheck] = useState("");
  const [safeOk, setSafeOk] = useState(false);
  const [evm, setEvm] = useState<{ provider: EIP1193Provider; address: Hex } | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [fees, setFees] = useState<{ bps: number; forward: bigint } | null>(null);
  const [burn, setBurn] = useState<Burn | null>(null);
  const [status, setStatus] = useState("");
  const [ataBalance, setAtaBalance] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setAtaInput(params.get("ata") ?? process.env.NEXT_PUBLIC_V2_CCTP_SAFE_ATA ?? "");
    try { const saved = localStorage.getItem(STORAGE_KEY); if (saved) setBurn(JSON.parse(saved)); } catch { /* ignore */ }
    fetch(`${IRIS}/v2/burn/USDC/fees/${SOURCE_DOMAIN}/${SOLANA_DOMAIN}?forward=true`)
      .then((r) => r.json())
      .then((rows: { finalityThreshold: number; minimumFee: number; forwardFee: { med: number } }[]) => {
        const fast = rows.find((row) => row.finalityThreshold === FAST_FINALITY);
        if (fast) setFees({ bps: fast.minimumFee, forward: BigInt(fast.forwardFee.med) });
      })
      .catch((error) => setLog(`fee API failed: ${String(error)}`));
  }, []);

  // The recipient must be the devnet USDC ATA of a v2 Safe PDA.
  useEffect(() => {
    setSafeOk(false);
    if (!ataInput) { setCheck(""); return; }
    let cancelled = false;
    (async () => {
      const ata = new PublicKey(ataInput);
      const info = await connection.getParsedAccountInfo(ata, "confirmed");
      const parsed = (info.value?.data as { parsed?: { info?: { mint: string; owner: string; tokenAmount: { uiAmountString: string } } } })?.parsed?.info;
      if (!parsed) throw new Error("not an initialized SPL token account on devnet");
      if (parsed.mint !== DEVNET_USDC) throw new Error(`mint ${parsed.mint} is not devnet USDC`);
      const safe = await connection.getAccountInfo(new PublicKey(parsed.owner), "confirmed");
      if (!safe || safe.owner.toBase58() !== V2_PROGRAM_ID) throw new Error(`ATA owner ${parsed.owner} is not a v2 Safe`);
      if (!cancelled) {
        setSafeOk(true);
        setAtaBalance(parsed.tokenAmount.uiAmountString);
        setCheck(`OK: devnet USDC ATA owned by Safe ${parsed.owner} (program ${V2_PROGRAM_ID})`);
      }
    })().catch((error) => { if (!cancelled) setCheck(`Recipient check failed: ${error instanceof Error ? error.message : String(error)}`); });
    return () => { cancelled = true; };
  }, [ataInput, connection]);

  // Poll Circle and the Safe ATA while a burn is tracked; survives page reloads via localStorage.
  useEffect(() => {
    if (!burn) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`${IRIS}/v2/messages/${SOURCE_DOMAIN}?transactionHash=${burn.txHash}`);
        const body = res.ok ? await res.json() : null;
        const message = body?.messages?.[0];
        const bal = await connection.getTokenAccountBalance(new PublicKey(burn.ata), "confirmed");
        setAtaBalance(bal.value.uiAmountString ?? "");
        setStatus(message
          ? `Circle: status=${message.status}; forwardState=${message.forwardState ?? "-"}; forwardTxHash=${message.forwardTxHash ?? "-"}`
          : `Circle: message not indexed yet (HTTP ${res.status})`);
      } catch (error) { setStatus(`poll error: ${String(error)}`); }
      if (!stop) setTimeout(tick, 5000);
    };
    void tick();
    return () => { stop = true; };
  }, [burn, connection]);

  const amountUnits = (() => { try { return parseUnits(amount || "0", 6); } catch { return BigInt(0); } })();
  // Protocol fee (bps, rounded up) plus the forwarding fee with a 20% buffer; maxFee is a ceiling.
  const maxFee = fees ? (amountUnits * BigInt(Math.ceil(fees.bps * 100))) / BigInt(1_000_000) + BigInt(1) + (fees.forward * BigInt(12)) / BigInt(10) : null;

  async function connectEvm() {
    setBusy(true);
    try {
      const provider = await findMetaMask();
      if (!provider) throw new Error("MetaMask (EIP-6963 io.metamask) not found");
      const [address] = await provider.request({ method: "eth_requestAccounts" }) as Hex[];
      try {
        await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x14a34" }] });
      } catch {
        await provider.request({ method: "wallet_addEthereumChain", params: [{
          chainId: "0x14a34", chainName: "Base Sepolia", rpcUrls: ["https://sepolia.base.org"],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: ["https://sepolia.basescan.org"] }] });
      }
      setEvm({ provider, address });
      setUsdc(await publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: erc20, functionName: "balanceOf", args: [address] }));
    } catch (error) { setLog(`EVM connect failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(false); }
  }

  async function burnToSafe() {
    if (!evm || !safeOk || !maxFee || amountUnits <= maxFee) return;
    setBusy(true);
    const lines: string[] = [];
    const say = (line: string) => { lines.push(line); setLog(lines.join("\n")); };
    try {
      const wallet = createWalletClient({ chain: baseSepolia, transport: custom(evm.provider), account: evm.address });
      if (await wallet.getChainId() !== baseSepolia.id) throw new Error("MetaMask is not on Base Sepolia");
      const mintRecipient = `0x${Buffer.from(new PublicKey(ataInput).toBytes()).toString("hex")}` as Hex;
      const allowance = await publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: erc20, functionName: "allowance", args: [evm.address, TOKEN_MESSENGER_V2] });
      if (allowance < amountUnits) {
        say(`Approve ${formatUnits(amountUnits, 6)} USDC to TokenMessengerV2 ${TOKEN_MESSENGER_V2}...`);
        const approveHash = await wallet.writeContract({ address: BASE_SEPOLIA_USDC, abi: erc20, functionName: "approve", args: [TOKEN_MESSENGER_V2, amountUnits] });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
        say(`Approve confirmed: ${approveHash}`);
      }
      say(`depositForBurnWithHook: amount=${formatUnits(amountUnits, 6)} maxFee=${formatUnits(maxFee, 6)} domain=${SOLANA_DOMAIN} mintRecipient=${ataInput} finality=${FAST_FINALITY}`);
      const txHash = await wallet.writeContract({
        address: TOKEN_MESSENGER_V2, abi: messenger, functionName: "depositForBurnWithHook",
        args: [amountUnits, SOLANA_DOMAIN, mintRecipient, BASE_SEPOLIA_USDC, `0x${"00".repeat(32)}` as Hex, maxFee, FAST_FINALITY, FORWARD_HOOK],
      });
      const next: Burn = { txHash, ata: ataInput, amount, startedAt: Date.now() };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      setBurn(next);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      say(`Burn ${receipt.status}: https://sepolia.basescan.org/tx/${txHash}\nPolling Circle and the Safe ATA...`);
    } catch (error) {
      say(`FAILED or cancelled: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  }

  const canBurn = !!evm && safeOk && !!maxFee && amountUnits > maxFee && usdc !== null && usdc >= amountUnits && !busy;

  return <main className="mx-auto max-w-2xl space-y-5 p-5 text-sm">
    <h1 className="text-2xl font-semibold">Yield AI v2 · CCTP Base Sepolia → Safe (devnet)</h1>
    <p>Testnet only. Burns Base Sepolia USDC via Circle CCTP V2 with the Forwarding Service; Circle mints devnet USDC directly into the Safe&apos;s USDC ATA. No bridge contract of ours is involved.</p>
    <label className="block">Safe USDC ATA (devnet)
      <input className="mt-1 w-full rounded border bg-transparent p-2 font-mono" value={ataInput} onChange={(e) => setAtaInput(e.target.value.trim())} />
    </label>
    <p className={safeOk ? "text-green-300" : "text-amber-200"}>{check || "Enter the Safe ATA."}</p>
    <label className="block">Amount (USDC, includes fees)
      <input className="mt-1 w-32 rounded border bg-transparent p-2" value={amount} onChange={(e) => setAmount(e.target.value)} />
    </label>
    <dl className="grid gap-2 break-all">
      <div><dt>Circle fee (fast)</dt><dd>{fees ? `${fees.bps} bps + forward ${formatUnits(fees.forward, 6)} USDC; maxFee ${maxFee !== null ? formatUnits(maxFee, 6) : "?"} USDC` : "loading..."}</dd></div>
      <div><dt>Expected minimum in Safe</dt><dd>{maxFee !== null && amountUnits > maxFee ? `${formatUnits(amountUnits - maxFee, 6)} USDC` : "amount must exceed maxFee"}</dd></div>
      <div><dt>EVM source (MetaMask)</dt><dd>{evm ? `${evm.address} · Base Sepolia USDC ${usdc !== null ? formatUnits(usdc, 6) : "?"}` : "not connected"}</dd></div>
      <div><dt>Safe ATA balance</dt><dd>{ataBalance || "—"} USDC</dd></div>
    </dl>
    <div className="flex flex-wrap gap-3">
      <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={busy} onClick={() => void connectEvm()}>Connect MetaMask (Base Sepolia)</button>
      <button type="button" className="rounded bg-white px-3 py-2 text-black disabled:opacity-40" disabled={!canBurn} onClick={() => void burnToSafe()}>Approve + burn to Safe</button>
    </div>
    {burn && <div className="space-y-1 rounded border p-3">
      <div>Burn tx: <a className="underline" href={`https://sepolia.basescan.org/tx/${burn.txHash}`} target="_blank" rel="noreferrer">{burn.txHash}</a> ({burn.amount} USDC → {burn.ata})</div>
      <div>{status || "polling..."}</div>
      <button type="button" className="underline" onClick={() => { try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ } setBurn(null); }}>Clear tracked burn</button>
    </div>}
    <pre className="whitespace-pre-wrap break-all rounded border p-3">{log || "Nothing sent yet."}</pre>
  </main>;
}
