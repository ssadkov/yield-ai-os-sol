"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, PublicKey, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ShieldCheck, ArrowDownToLine, ArrowUpFromLine, Trash2, RefreshCw, SlidersHorizontal, TrendingUp } from "lucide-react";
import { PROGRAM_ID, USDC_DECIMALS, USDC_MINT } from "@/lib/constants";
import {
  DEVNET_GENESIS, MAINNET_GENESIS, explorerTx, ixCloseEmptyTokenAccount, ixCloseSafe, ixDepositUsdc,
  ixInitialize, ixSetAllocation, ixWithdraw, ixWithdrawExcessLamports, readSafe, sendOwnerTransaction,
  safeCreationCostLamports, fetchKaminoAccounts, fetchKaminoMetrics, fetchKaminoWithdrawalPlan,
  ixKaminoDeposit, ixKaminoWithdraw, loadLookupTables,
  KAMINO_SHARES_MINT, MAX_ROUTES, MIN_FEE_LAMPORTS, ROUTE_KAMINO_USDC, ROUTES,
  type KaminoMetrics, type SafeState, type SafeToken,
} from "@/lib/safeV2";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false },
);

function toRaw(ui: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(ui.trim());
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(decimals, "0");
  if (fraction.length > decimals) return null;
  return BigInt(match[1]) * BigInt(10) ** BigInt(decimals) + BigInt(fraction || "0");
}

function short(key: string) {
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export function SafeV2Panel() {
  const { connection } = useConnection();
  const { publicKey, wallet } = useWallet();
  const [mounted, setMounted] = useState(false);
  const [genesis, setGenesis] = useState<string | null>(null);
  const [safe, setSafe] = useState<SafeState | null>(null);
  const [walletUsdc, setWalletUsdc] = useState<bigint | null>(null);
  const [walletSol, setWalletSol] = useState<number | null>(null);
  const [creationCost, setCreationCost] = useState<number | null>(null);
  const [kaminoMetrics, setKaminoMetrics] = useState<KaminoMetrics | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmounts, setWithdrawAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  /** Draft targets in percent, indexed like ROUTES. */
  const [allocationDraft, setAllocationDraft] = useState<number[]>(ROUTES.map(() => 0));
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => setMounted(true), []);

  const refresh = useCallback(async () => {
    if (!publicKey) { setSafe(null); return; }
    setGenesis(await connection.getGenesisHash());
    setSafe(await readSafe(connection, publicKey));
    setWalletSol(await connection.getBalance(publicKey, "confirmed"));
    setCreationCost(await safeCreationCostLamports(connection));
    setKaminoMetrics(await fetchKaminoMetrics().catch(() => null));
    const ata = getAssociatedTokenAddressSync(USDC_MINT, publicKey);
    const balance = await connection.getTokenAccountBalance(ata, "confirmed").catch(() => null);
    setWalletUsdc(balance ? BigInt(balance.value.amount) : BigInt(0));
  }, [connection, publicKey]);

  useEffect(() => { void refresh().catch((error) => setLog([`Read failed: ${String(error)}`])); }, [refresh]);
  useEffect(() => {
    if (safe?.allocationBps) setAllocationDraft(ROUTES.map((route) => safe.allocationBps![route.index] / 100));
  }, [safe]);

  const allocatedPercent = allocationDraft.reduce((sum, value) => sum + value, 0);
  const allocationChanged = !safe?.allocationBps
    || ROUTES.some((route, i) => safe.allocationBps![route.index] !== Math.round(allocationDraft[i] * 100));

  function setRoutePercent(i: number, value: number) {
    // Keep the total at or below 100%: the rest stays idle USDC.
    const others = allocationDraft.reduce((sum, v, j) => (j === i ? sum : sum + v), 0);
    setAllocationDraft((prev) => prev.map((v, j) => (j === i ? Math.min(value, 100 - others) : v)));
  }

  function allocationBps() {
    const bps = Array(MAX_ROUTES).fill(0) as number[];
    ROUTES.forEach((route, i) => { bps[route.index] = Math.round(allocationDraft[i] * 100); });
    return bps;
  }

  const cluster = genesis === MAINNET_GENESIS ? "Mainnet" : genesis === DEVNET_GENESIS ? "Devnet" : "…";
  const isMetaMask = wallet?.adapter.name.toLowerCase() === "metamask";
  const metaMaskBlocked = isMetaMask && cluster === "Devnet";
  const noFeeSol = walletSol !== null && walletSol < MIN_FEE_LAMPORTS;
  const cannotCreate = walletSol !== null && creationCost !== null && walletSol < creationCost;
  const sol = (lamports: number) => (lamports / LAMPORTS_PER_SOL).toFixed(4);
  // Kamino USDC position: shares live in the Safe; value = shares x tokensPerShare (both 6 decimals).
  const isMainnet = cluster === "Mainnet";
  const kaminoShares = safe?.tokens.find((token) => token.mint.equals(KAMINO_SHARES_MINT))?.amount ?? BigInt(0);
  const kaminoEstimate = kaminoMetrics ? Number(kaminoShares) / 1e6 * kaminoMetrics.tokensPerShare : null;
  const kaminoValue = kaminoEstimate !== null && Number.isFinite(kaminoEstimate) ? kaminoEstimate : null;
  const kaminoPrincipal = safe?.routePrincipal[ROUTE_KAMINO_USDC] ?? BigInt(0);
  const idleUsdc = safe?.tokens.find((token) => token.isUsdc)?.amount ?? BigInt(0);
  const kaminoBps = safe?.allocationBps?.[ROUTE_KAMINO_USDC] ?? 0;
  // The program caps one deposit at idle x target; Kamino's minimum deposit is 0.001 USDC.
  const kaminoPut = idleUsdc * BigInt(kaminoBps) / BigInt(10_000);
  const canKaminoDeposit = isMainnet && kaminoPut >= BigInt(1_000);
  const usd = (raw: bigint) => (Number(raw) / 1e6).toFixed(2);
  const safeValue = kaminoShares > BigInt(0) && kaminoValue === null
    ? null : Number(idleUsdc) / 1e6 + (kaminoValue ?? 0);
  const showLabControls = process.env.NEXT_PUBLIC_V2_LAB_CONTROLS === "1";

  async function buildKaminoDeposit() {
    if (!publicKey) return [];
    const kamino = await fetchKaminoAccounts(publicKey, (Number(kaminoPut) / 1e6).toString());
    return { instructions: await ixKaminoDeposit(connection, publicKey, kaminoPut, kamino), lookupTables: await loadLookupTables(connection, kamino.lookupTables) };
  }
  async function buildKaminoWithdrawAll() {
    if (!publicKey) return [];
    const plan = await fetchKaminoWithdrawalPlan(publicKey, kaminoShares);
    return { instructions: await ixKaminoWithdraw(connection, publicKey, plan), lookupTables: await loadLookupTables(connection, plan.lookupTables) };
  }

  const emptyTokens = safe?.tokens.filter((token) => token.amount === BigInt(0)) ?? [];
  const heldTokens = safe?.tokens.filter((token) => token.amount > BigInt(0) && !token.mint.equals(KAMINO_SHARES_MINT)) ?? [];
  const otherHeldTokens = heldTokens.filter((token) => !token.isUsdc);
  const hasUnwithdrawnAssets = heldTokens.length > 0 || kaminoShares > BigInt(0);
  const canFullExit = !!safe?.exists && otherHeldTokens.length === 0
    && (idleUsdc > BigInt(0) || kaminoShares > BigInt(0))
    && (kaminoShares === BigInt(0) || isMainnet);

  type Built = TransactionInstruction[] | { instructions: TransactionInstruction[]; lookupTables: AddressLookupTableAccount[] };
  async function run(label: string, build: () => Promise<Built>) {
    if (!publicKey || !wallet) return;
    setBusy(label);
    const lines = [`${label}…`];
    setLog([...lines]);
    const say = (line: string) => { lines.push(line); setLog([...lines]); };
    try {
      const built = await build();
      const { instructions, lookupTables } = Array.isArray(built) ? { instructions: built, lookupTables: [] } : built;
      const signature = await sendOwnerTransaction({ connection, adapter: wallet.adapter, owner: publicKey, instructions, lookupTables, onStatus: say });
      say(`Confirmed: ${explorerTx(signature, genesis)}`);
      await refresh();
    } catch (error) {
      say(`Failed or cancelled: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(null); }
  }

  async function runFullExit() {
    if (!publicKey || !wallet) return;
    setBusy("Full withdrawal");
    const lines = ["Full withdrawal…"];
    setLog([...lines]);
    const say = (line: string) => { lines.push(line); setLog([...lines]); };
    try {
      let current = await readSafe(connection, publicKey);
      if (current.tokens.some((token) => token.amount > BigInt(0) && !token.isUsdc && !token.mint.equals(KAMINO_SHARES_MINT))) {
        throw new Error("Other Safe assets must be withdrawn separately");
      }
      let shares = current.tokens.find((token) => token.mint.equals(KAMINO_SHARES_MINT))?.amount ?? BigInt(0);
      for (let step = 0; shares > BigInt(0); step++) {
        if (!isMainnet) throw new Error("Kamino withdrawal requires Solana Mainnet");
        if (step >= 8) throw new Error("Kamino needs more than eight withdrawal steps; retry after refreshing the Safe");
        const plan = await fetchKaminoWithdrawalPlan(publicKey, shares);
        const instructions = await ixKaminoWithdraw(connection, publicKey, { ...plan, withdrawals: [plan.withdrawals[0]] });
        const lookupTables = await loadLookupTables(connection, plan.lookupTables);
        const signature = await sendOwnerTransaction({ connection, adapter: wallet.adapter, owner: publicKey,
          instructions, lookupTables, onStatus: say });
        say(`Kamino step ${step + 1} confirmed: ${explorerTx(signature, genesis)}`);
        current = await readSafe(connection, publicKey);
        const remaining = current.tokens.find((token) => token.mint.equals(KAMINO_SHARES_MINT))?.amount ?? BigInt(0);
        if (remaining >= shares) throw new Error("Kamino shares did not decrease; refresh before retrying");
        shares = remaining;
      }
      const usdc = current.tokens.find((token) => token.isUsdc);
      if (usdc && usdc.amount > BigInt(0)) {
        const signature = await sendOwnerTransaction({ connection, adapter: wallet.adapter, owner: publicKey,
          instructions: [await ixWithdraw(connection, publicKey, usdc, usdc.amount)], onStatus: say });
        say(`USDC withdrawal confirmed: ${explorerTx(signature, genesis)}`);
      }
      say("All supported USDC assets have been returned to your wallet.");
    } catch (error) {
      say(`Stopped: ${error instanceof Error ? error.message : String(error)}. Already confirmed steps remain on chain; refresh and retry.`);
    } finally { await refresh().catch(() => {}); setBusy(null); }
  }

  const depositRaw = toRaw(depositAmount, USDC_DECIMALS);
  const canDeposit = !!safe?.exists && depositRaw !== null && depositRaw > BigInt(0)
    && walletUsdc !== null && depositRaw <= walletUsdc;

  function withdrawRaw(token: SafeToken) {
    const input = withdrawAmounts[token.pubkey.toBase58()];
    return input ? toRaw(input, token.decimals) : token.amount;
  }

  // Everything that can be cleaned in one owner signature: empty accounts, excess SOL, and the Safe
  // itself when it will own no token accounts afterwards.
  async function buildCleanup(includeCloseSafe: boolean) {
    if (!publicKey || !safe) return [];
    const ixs: TransactionInstruction[] = [];
    for (const token of emptyTokens) ixs.push(await ixCloseEmptyTokenAccount(connection, publicKey, token));
    if (includeCloseSafe) ixs.push(await ixCloseSafe(connection, publicKey));
    else if (safe.excessLamports > 0) ixs.push(await ixWithdrawExcessLamports(connection, publicKey));
    return ixs;
  }

  const card = "rounded-lg border border-border bg-card p-5 space-y-3";
  const button = "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

  return <main className="mx-auto max-w-3xl space-y-5 p-5 text-sm">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold"><ShieldCheck className="h-6 w-6 text-primary" /> Yield AI Safe v2</h1>
        <p className="text-muted-foreground">Your personal Solana Safe. Only your wallet can move funds out. Program {short(PROGRAM_ID.toBase58())} · {cluster}</p>
      </div>
      <WalletMultiButton />
    </header>

    {metaMaskBlocked && <p className="rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-amber-200">
      MetaMask cannot sign Solana Devnet transactions. Use Phantom or Solflare here; MetaMask works once the Safe is on Mainnet.
    </p>}

    {mounted && publicKey && noFeeSol && <p className="rounded-md border border-amber-500/60 bg-amber-500/10 p-3 text-amber-200">
      Your wallet has no SOL on {cluster === "…" ? "this network" : `Solana ${cluster}`}. Every action needs a small SOL fee (about 0.00001 SOL){safe && !safe.exists && creationCost ? `; creating the Safe needs about ${sol(creationCost)} SOL of refundable rent` : ""}.
      {cluster === "Devnet" && <> Get free devnet SOL at <a className="underline" href="https://faucet.solana.com" target="_blank" rel="noreferrer">faucet.solana.com</a>.</>}
    </p>}

    {!mounted || !publicKey ? <section className={card}><p>Connect a Solana wallet to open your Safe.</p></section> : <>
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Safe</h2>
          <button type="button" className={`${button} text-muted-foreground hover:text-foreground`} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" /> Refresh</button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 break-all">
          <dt className="text-muted-foreground">Owner</dt><dd>{publicKey.toBase58()}</dd>
          <dt className="text-muted-foreground">Wallet SOL</dt><dd>{walletSol === null ? "…" : `${sol(walletSol)} SOL`}</dd>
          <dt className="text-muted-foreground">Safe address</dt><dd>{safe?.vault.toBase58() ?? "…"}</dd>
          <dt className="text-muted-foreground">Status</dt><dd>{safe ? safe.exists ? "Active" : "Not created" : "…"}</dd>
          {safe?.exists && <><dt className="text-muted-foreground">Agent</dt><dd>{!safe.agent || safe.agent.equals(PublicKey.default) ? "None (owner-only)" : safe.agent.toBase58()}</dd></>}
        </dl>
        {safe && !safe.exists && <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
          disabled={!!busy || metaMaskBlocked || cannotCreate} onClick={() => void run("Create Safe", async () => [await ixInitialize(connection, publicKey)])}>
          <ShieldCheck className="h-4 w-4" /> Create Safe
        </button>}
        {safe && !safe.exists && creationCost !== null && <p className="text-muted-foreground">
          Creating the Safe costs about {sol(creationCost)} SOL of rent, refunded when you close it.{cannotCreate ? ` Your wallet has ${sol(walletSol ?? 0)} SOL.` : ""}
        </p>}
        {safe && !safe.exists && safe.tokens.length > 0 && <p className="text-amber-200">This address already owns token accounts from a previous Safe. Creating the Safe again restores access to them.</p>}
      </section>

      {safe?.exists && <section className={card}>
        <h2 className="text-lg font-semibold">Your Safe value</h2>
        <p className="text-3xl font-semibold tabular-nums">{safeValue === null ? "Value temporarily unavailable" : `${safeValue.toFixed(2)} USDC`}</p>
        <p className="text-muted-foreground">Includes {usd(idleUsdc)} USDC ready to withdraw{kaminoShares > BigInt(0) ? " and an estimated Kamino position" : ""}. The final amount is known after Kamino redemption and fees.</p>
        <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`}
          disabled={!!busy || !canFullExit || metaMaskBlocked}
          onClick={() => void runFullExit()}>
          <ArrowUpFromLine className="h-4 w-4" /> Withdraw all USDC
        </button>
        {kaminoShares > BigInt(0) && <p className="text-muted-foreground">This may require several wallet approvals: first redeem Kamino shares, then send USDC to your wallet. Each confirmed step can be resumed after interruption.</p>}
        {otherHeldTokens.length > 0 && <p className="text-amber-200">The Safe also has other assets. Withdraw those separately before using full USDC withdrawal.</p>}
      </section>}

      {safe?.exists && <section className={card}>
        <h2 className="text-lg font-semibold">Deposit USDC</h2>
        <p className="text-muted-foreground">Wallet USDC: {walletUsdc === null ? "…" : (Number(walletUsdc) / 10 ** USDC_DECIMALS).toString()}</p>
        <div className="flex flex-wrap gap-2">
          <input className="w-40 rounded-md border border-border bg-transparent px-3 py-2" inputMode="decimal" placeholder="0.00"
            value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
          <button type="button" className={`${button} border border-border`} onClick={() => walletUsdc !== null && setDepositAmount((Number(walletUsdc) / 10 ** USDC_DECIMALS).toString())}>Max</button>
          <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!!busy || !canDeposit || metaMaskBlocked}
            onClick={() => depositRaw && void run("Deposit USDC", async () => [await ixDepositUsdc(connection, publicKey, depositRaw)])}>
            <ArrowDownToLine className="h-4 w-4" /> Deposit
          </button>
        </div>
      </section>}

      {showLabControls && safe?.exists && <section className={card}>
        <h2 className="flex items-center gap-2 text-lg font-semibold"><SlidersHorizontal className="h-4 w-4" /> Allocation</h2>
        <p className="text-muted-foreground">Your target split, stored in the Safe. The agent may only allocate within these limits once the Kamino and ONyc routes ship; today nothing is moved automatically.</p>
        {!safe.allocationBps && <p className="text-amber-200">This Safe was created before allocation targets existed; saving will initialise them.</p>}
        {ROUTES.map((route, i) => <label key={route.key} className="block space-y-1">
          <span className="flex justify-between"><span>{route.label}</span><span className="tabular-nums">{allocationDraft[i]}%</span></span>
          <input type="range" min={0} max={100} step={5} className="w-full accent-primary" value={allocationDraft[i]}
            onChange={(e) => setRoutePercent(i, Number(e.target.value))} />
        </label>)}
        <p className="text-muted-foreground">Idle USDC: <span className="tabular-nums">{100 - allocatedPercent}%</span></p>
        <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!!busy || !allocationChanged || metaMaskBlocked}
          onClick={() => void run("Save allocation", async () => [await ixSetAllocation(connection, publicKey, allocationBps())])}>
          Save allocation
        </button>
      </section>}

      {showLabControls && safe?.exists && <section className={card}>
        <h2 className="flex items-center gap-2 text-lg font-semibold"><TrendingUp className="h-4 w-4" /> Kamino USDC</h2>
        <p className="text-muted-foreground">
          Lending yield via the Kamino USDC vault{kaminoMetrics?.apy != null ? ` · APY ${(kaminoMetrics.apy * 100).toFixed(2)}%` : ""}.
          USDC only moves between your Safe and Kamino; a 5% fee applies to realized gains only.
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted-foreground">Position</dt>
          <dd>{kaminoShares > BigInt(0) ? `${kaminoValue?.toFixed(2) ?? "…"} USDC (${usd(kaminoShares)} shares)` : "None"}</dd>
          <dt className="text-muted-foreground">Invested</dt><dd>{usd(kaminoPrincipal)} USDC</dd>
          <dt className="text-muted-foreground">Target</dt><dd>{kaminoBps / 100}% of idle USDC</dd>
        </dl>
        {!isMainnet && <p className="text-amber-200">Kamino runs on Solana Mainnet only; these actions are disabled on {cluster}.</p>}
        {isMainnet && kaminoBps === 0 && <p className="text-muted-foreground">Set a Kamino share in Allocation to enable deposits.</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={!!busy || !canKaminoDeposit}
            onClick={() => void run(`Put ${usd(kaminoPut)} USDC into Kamino`, buildKaminoDeposit)}>
            <ArrowDownToLine className="h-4 w-4" /> Put {usd(kaminoPut)} USDC to work
          </button>
          <button type="button" className={`${button} border border-border hover:bg-accent`} disabled={!!busy || !isMainnet || kaminoShares === BigInt(0)}
            onClick={() => void run("Withdraw all from Kamino", buildKaminoWithdrawAll)}>
            <ArrowUpFromLine className="h-4 w-4" /> Withdraw all from Kamino
          </button>
        </div>
      </section>}

      {(showLabControls || otherHeldTokens.length > 0) && safe && (safe.exists || safe.tokens.length > 0) && <section className={card}>
        <h2 className="text-lg font-semibold">Holdings</h2>
        {heldTokens.length === 0 ? <p className="text-muted-foreground">No tokens in the Safe.</p> :
          <ul className="space-y-2">{heldTokens.map((token) => {
            const raw = withdrawRaw(token);
            const valid = raw !== null && raw > BigInt(0) && raw <= token.amount;
            return <li key={token.pubkey.toBase58()} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3">
              <div><div className="font-medium">{token.isUsdc ? "USDC" : short(token.mint.toBase58())}</div><div className="text-muted-foreground">{token.uiAmount}</div></div>
              <div className="flex flex-wrap gap-2">
                <input className="w-32 rounded-md border border-border bg-transparent px-3 py-2" inputMode="decimal" placeholder={`all ${token.uiAmount}`}
                  value={withdrawAmounts[token.pubkey.toBase58()] ?? ""} onChange={(e) => setWithdrawAmounts((prev) => ({ ...prev, [token.pubkey.toBase58()]: e.target.value }))} />
                <button type="button" className={`${button} border border-border hover:bg-accent`} disabled={!!busy || !valid || !safe.exists || metaMaskBlocked}
                  onClick={() => raw && void run(`Withdraw ${token.isUsdc ? "USDC" : short(token.mint.toBase58())}`, async () => [await ixWithdraw(connection, publicKey, token, raw)])}>
                  <ArrowUpFromLine className="h-4 w-4" /> Withdraw
                </button>
              </div>
            </li>;
          })}</ul>}
      </section>}

      {safe?.exists && <section className={card}>
        <h2 className="text-lg font-semibold">Clean up and reclaim rent</h2>
        <p className="text-muted-foreground">
          {emptyTokens.length} empty token account(s) · {(safe.excessLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL above the Safe&apos;s rent minimum.
          Rent always returns to your wallet.
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={`${button} border border-border hover:bg-accent`} disabled={!!busy || metaMaskBlocked || (emptyTokens.length === 0 && safe.excessLamports === 0)}
            onClick={() => void run("Reclaim rent", () => buildCleanup(false))}>
            <Trash2 className="h-4 w-4" /> Close empty accounts{safe.excessLamports > 0 ? " + return excess SOL" : ""}
          </button>
          <button type="button" className={`${button} border border-red-500/60 text-red-300 hover:bg-red-500/10`} disabled={!!busy || metaMaskBlocked || hasUnwithdrawnAssets}
            title={hasUnwithdrawnAssets ? "Withdraw all holdings first" : undefined}
            onClick={() => void run("Close Safe", () => buildCleanup(true))}>
            <Trash2 className="h-4 w-4" /> Close Safe
          </button>
        </div>
        {hasUnwithdrawnAssets && <p className="text-muted-foreground">Close Safe unlocks after every holding is withdrawn.</p>}
      </section>}

      <pre className="min-h-12 whitespace-pre-wrap break-all rounded-md border border-border p-3">{log.length ? log.join("\n") : busy ?? "No transactions yet. Every action is one transaction signed only by your wallet."}</pre>
    </>}
  </main>;
}
