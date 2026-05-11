import BN from "bn.js";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { JUPITER_XSTOCKS_USDC_MARKETS, type JupiterBorrowCollateralMarket } from "@/lib/jupiterBorrowMarkets";
import { fetchPrices, type JupiterPriceEntry } from "@/lib/jupiter";
import { fetchJupiterLendMarkets } from "@/server/agent/protocols/jupiterLendMarkets";
import { wrapProtocolCpiIx } from "./wrapCpi";

export const JUPITER_LEND_PROGRAM_ID = new PublicKey("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");

const COMPUTE_UNIT_LIMIT = 1_400_000;
// Target buffer the vault PDA should hold to cover Jupiter setup rent
// (creating a position/tick account, etc). 0.025 SOL is plenty for the
// real on-chain costs; the previous 0.05 SOL was wasteful and drained
// user wallets across repeated activations.
const VAULT_PDA_LAMPORT_BUFFER = 25_000_000;
// Reserve on the authority wallet so it can still pay tx fees after the
// top-up transfer goes out.
const AUTHORITY_FEE_RESERVE = 5_000_000;

async function planVaultTopUp(args: {
  connection: Connection;
  authority: PublicKey;
  vault: PublicKey;
  needsRent: boolean;
}): Promise<{
  topUpIxs: TransactionInstruction[];
  topUpLamports: number;
  currentVaultLamports: number;
}> {
  const currentVaultLamports = await args.connection.getBalance(args.vault, "confirmed");
  if (!args.needsRent) {
    return { topUpIxs: [], topUpLamports: 0, currentVaultLamports };
  }
  const idealTopUp = Math.max(0, VAULT_PDA_LAMPORT_BUFFER - currentVaultLamports);
  if (idealTopUp === 0) {
    return { topUpIxs: [], topUpLamports: 0, currentVaultLamports };
  }
  const authorityLamports = await args.connection.getBalance(args.authority, "confirmed");
  const maxAffordable = Math.max(0, authorityLamports - AUTHORITY_FEE_RESERVE);
  const topUpLamports = Math.min(idealTopUp, maxAffordable);
  if (topUpLamports === 0) {
    // Authority can't spare anything. Let the underlying tx try with whatever
    // is already on the vault — if rent is short, the SDK will surface a
    // clearer error than aborting here.
    return { topUpIxs: [], topUpLamports: 0, currentVaultLamports };
  }
  return {
    topUpIxs: [
      SystemProgram.transfer({
        fromPubkey: args.authority,
        toPubkey: args.vault,
        lamports: topUpLamports,
      }),
    ],
    topUpLamports,
    currentVaultLamports,
  };
}

export { JUPITER_XSTOCKS_USDC_MARKETS, type JupiterBorrowCollateralMarket };

async function loadJupiterBorrow(): Promise<typeof import("@jup-ag/lend/borrow")> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("@jup-ag/lend/borrow")>;
  return dynamicImport("@jup-ag/lend/borrow");
}

async function loadRuntimeWeb3(): Promise<typeof import("@solana/web3.js")> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<typeof import("@solana/web3.js")>;
  return dynamicImport("@solana/web3.js");
}

function cloneAlt(alt: AddressLookupTableAccount): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: new PublicKey(alt.key.toBase58()),
    state: {
      deactivationSlot: alt.state.deactivationSlot,
      lastExtendedSlot: alt.state.lastExtendedSlot,
      lastExtendedSlotStartIndex: alt.state.lastExtendedSlotStartIndex,
      addresses: alt.state.addresses.map((address) => new PublicKey(address.toBase58())),
    },
  });
}

export type BuiltJupiterBorrowDeposit = {
  requiredPrograms: string[];
  txs: {
    label: string;
    ixs: TransactionInstruction[];
  }[];
  alts: AddressLookupTableAccount[];
  summary: {
    vaultId: number;
    nftId: number;
    directCount: number;
    cpiCount: number;
    sdkIxCount: number;
    topUpLamports: number;
    currentVaultLamports: number;
    collateralDecimals: number;
    requestedAmountRaw: string;
    operateAmount: string;
    sourceBalanceRaw: string | null;
    programs: string[];
  };
};

export type BuiltJupiterBorrowInitPosition = {
  nftId: number;
  tx: {
    label: string;
    ixs: TransactionInstruction[];
  };
};

export type ExistingJupiterBorrowPosition = {
  positionId: number;
  tokenAccount: string;
  scannedFrom: number;
  scannedTo: number;
};

function normalizeIx(ix: TransactionInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId.toBase58()),
    keys: ix.keys.map((key) => ({
      pubkey: new PublicKey(key.pubkey.toBase58()),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(ix.data),
  });
}

function replaceVaultSignerWithAuthority(ix: TransactionInstruction, vault: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId.toBase58()),
    keys: ix.keys.map((key) => ({
      pubkey: key.isSigner && key.pubkey.equals(vault) ? authority : new PublicKey(key.pubkey.toBase58()),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(ix.data),
  });
}

function getCollateralMarket(vaultId: number): JupiterBorrowCollateralMarket | undefined {
  return JUPITER_XSTOCKS_USDC_MARKETS.find((market) => market.vaultId === vaultId);
}

/** Fetches all NFT (decimals=0, amount=1) token accounts owned by the vault in a single RPC call. */
export async function fetchVaultNftAtaSet(args: {
  connection: Connection;
  vault: PublicKey;
}): Promise<Set<string>> {
  const res = await args.connection.getParsedTokenAccountsByOwner(
    args.vault,
    { programId: TOKEN_PROGRAM_ID },
    "confirmed",
  );
  const set = new Set<string>();
  for (const { pubkey, account } of res.value) {
    const parsed = (account.data as { parsed?: { info?: { tokenAmount?: { amount?: string; decimals?: number } } } }).parsed;
    const info = parsed?.info;
    if (!info?.tokenAmount) continue;
    if (info.tokenAmount.decimals === 0 && info.tokenAmount.amount === "1") {
      set.add(pubkey.toBase58());
    }
  }
  return set;
}

const DEFAULT_POSITION_SCAN_DEPTH = 5000;

/** Returns all positionIds the vault holds for a given Jupiter Borrow market.
 *  Local scan against a pre-fetched set of vault-owned NFT ATAs — no extra RPC per candidate.
 *  Mutates `vaultNftAtas` (deletes matched entries) so callers can stop early across markets. */
export async function findAllVaultJupiterBorrowPositionIds(args: {
  connection: Connection;
  vault: PublicKey;
  vaultId: number;
  vaultNftAtas: Set<string>;
  maxScan?: number;
}): Promise<number[]> {
  if (args.vaultNftAtas.size === 0) return [];
  const [{ getInitPositionContext, getInitPositionIx }, runtimeWeb3] = await Promise.all([
    loadJupiterBorrow(),
    loadRuntimeWeb3(),
  ]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");
  const sdkVault = new runtimeWeb3.PublicKey(args.vault.toBase58());
  const next = await getInitPositionIx({
    vaultId: args.vaultId,
    connection: sdkConnection as unknown as Connection,
    signer: sdkVault as unknown as PublicKey,
  });

  const upperBound = Math.max(1, next.nftId - 1);
  const depth = args.maxScan ?? DEFAULT_POSITION_SCAN_DEPTH;
  const lowerBound = Math.max(1, upperBound - depth + 1);
  const found: number[] = [];
  for (let positionId = upperBound; positionId >= lowerBound; positionId--) {
    if (args.vaultNftAtas.size === 0) break;
    const context = getInitPositionContext(args.vaultId, positionId, sdkVault as unknown as PublicKey);
    const ata = context.positionTokenAccount.toBase58();
    if (args.vaultNftAtas.has(ata)) {
      found.push(positionId);
      args.vaultNftAtas.delete(ata);
    }
  }
  return found;
}

export async function findExistingVaultJupiterBorrowPosition(args: {
  connection: Connection;
  vault: PublicKey;
  vaultId: number;
  scanLimit?: number;
}): Promise<ExistingJupiterBorrowPosition | null> {
  const vaultNftAtas = await fetchVaultNftAtaSet({
    connection: args.connection,
    vault: args.vault,
  });
  const ids = await findAllVaultJupiterBorrowPositionIds({
    connection: args.connection,
    vault: args.vault,
    vaultId: args.vaultId,
    vaultNftAtas,
  });
  if (ids.length === 0) return null;
  const positionId = ids[0];
  const [{ getInitPositionContext }, runtimeWeb3] = await Promise.all([
    loadJupiterBorrow(),
    loadRuntimeWeb3(),
  ]);
  const sdkVault = new runtimeWeb3.PublicKey(args.vault.toBase58());
  const context = getInitPositionContext(args.vaultId, positionId, sdkVault as unknown as PublicKey);
  return {
    positionId,
    tokenAccount: context.positionTokenAccount.toBase58(),
    scannedFrom: positionId,
    scannedTo: 1,
  };
}

function rawToUiAmount(raw: string, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

function jupiterAccountingDecimals(decimals: number): number {
  return Math.max(decimals, 9);
}

async function getVaultCollateralBalanceRaw(args: {
  connection: Connection;
  vault: PublicKey;
  mint: PublicKey;
}): Promise<BN | null> {
  const token2022Ata = getAssociatedTokenAddressSync(args.mint, args.vault, true, TOKEN_2022_PROGRAM_ID);
  const splAta = getAssociatedTokenAddressSync(args.mint, args.vault, true, TOKEN_PROGRAM_ID);
  for (const ata of [token2022Ata, splAta]) {
    try {
      const balance = await args.connection.getTokenAccountBalance(ata, "confirmed");
      return new BN(balance.value.amount);
    } catch {
      continue;
    }
  }
  return null;
}

function clampOperateAmountForVaultBalance(amount: BN, sourceBalance: BN | null): BN {
  if (!sourceBalance) return amount;
  if (sourceBalance.lte(new BN(1))) return new BN(0);

  // Jupiter Borrow can round the Token-2022 collateral transfer up by 1 raw unit.
  // Leaving 1 raw unit in the vault keeps MAX deposits from failing with insufficient funds.
  return BN.min(amount, sourceBalance.sub(new BN(1)));
}

export type VaultJupiterBorrowPosition = {
  protocol: "Jupiter";
  vaultId: number;
  positionId: number;
  market: string;
  collateralSymbol: string;
  collateralMint: string;
  collateralRaw: string;
  collateralAmount: number;
  borrowSymbol: "USDC" | "JupUSD";
  borrowMint: string;
  debtRaw: string;
  debtAmount: number;
  collateralUsd: number | null;
  debtUsd: number | null;
  netUsd: number | null;
  depositApy: number | null;
  borrowAPY: number | null;
  netApy: number | null;
  tokenAccount: string;
};

export async function readVaultJupiterBorrowPositions(args: {
  connection: Connection;
  vault: PublicKey;
}): Promise<VaultJupiterBorrowPosition[]> {
  const [{ getCurrentPosition }, runtimeWeb3] = await Promise.all([loadJupiterBorrow(), loadRuntimeWeb3()]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");
  const [rates, prices] = await Promise.all([
    fetchJupiterLendMarkets({
      vaultIds: JUPITER_XSTOCKS_USDC_MARKETS.map((market) => market.vaultId),
    }).catch(() => ({ data: [] })),
    fetchPrices([
      ...JUPITER_XSTOCKS_USDC_MARKETS.map((market) => market.mint),
      ...JUPITER_XSTOCKS_USDC_MARKETS.map((market) => market.borrowMint),
    ]).catch((): Record<string, JupiterPriceEntry> => ({})),
  ]);
  const ratesByVaultId = new Map<number, { depositApy: number; borrowAPY: number }>();
  for (const pool of rates.data ?? []) {
    const vaultId = Number(pool.originalPool?.vaultId ?? 0);
    if (vaultId > 0) {
      ratesByVaultId.set(vaultId, {
        depositApy: Number(pool.depositApy ?? 0),
        borrowAPY: Number(pool.borrowAPY ?? 0),
      });
    }
  }

  let vaultNftAtas: Set<string>;
  try {
    vaultNftAtas = await fetchVaultNftAtaSet({
      connection: args.connection,
      vault: args.vault,
    });
  } catch (err) {
    console.error(
      `[jupiterBorrow] fetchVaultNftAtaSet failed for vault=${args.vault.toBase58()}:`,
      err,
    );
    return [];
  }
  console.log(
    `[jupiterBorrow] vault=${args.vault.toBase58()} holds ${vaultNftAtas.size} NFT token accounts`,
  );

  const { getInitPositionContext } = await loadJupiterBorrow();
  const sdkVault = new runtimeWeb3.PublicKey(args.vault.toBase58());

  const flattened: Array<{ market: typeof JUPITER_XSTOCKS_USDC_MARKETS[number]; positionId: number }> = [];
  for (const market of JUPITER_XSTOCKS_USDC_MARKETS) {
    let positionIds: number[] = [];
    try {
      positionIds = await findAllVaultJupiterBorrowPositionIds({
        connection: args.connection,
        vault: args.vault,
        vaultId: market.vaultId,
        vaultNftAtas,
      });
    } catch (err) {
      console.error(
        `[jupiterBorrow] findAllVaultJupiterBorrowPositionIds failed for vault=${args.vault.toBase58()} market=${market.symbol} vaultId=${market.vaultId}:`,
        err,
      );
      continue;
    }
    console.log(
      `[jupiterBorrow] vault=${args.vault.toBase58()} market=${market.symbol} found positions: [${positionIds.join(",")}]`,
    );
    for (const positionId of positionIds) {
      flattened.push({ market, positionId });
    }
  }

  const positions = await Promise.all(
    flattened.map(async ({ market, positionId }) => {
      let current: Awaited<ReturnType<typeof getCurrentPosition>>;
      try {
        current = await getCurrentPosition({
          vaultId: market.vaultId,
          positionId,
          connection: sdkConnection as unknown as Connection,
        });
      } catch (err) {
        console.error(
          `[jupiterBorrow] getCurrentPosition failed for vault=${args.vault.toBase58()} market=${market.symbol} vaultId=${market.vaultId} positionId=${positionId}:`,
          err,
        );
        return null;
      }
      const collateralRaw = current.colRaw.toString();
      const debtRaw = current.debtRaw.toString();
      if (BigInt(collateralRaw) === BigInt(0) && BigInt(debtRaw) === BigInt(0)) return null;
      let positionTokenAccount = "";
      try {
        const ctx = getInitPositionContext(market.vaultId, positionId, sdkVault as unknown as PublicKey);
        positionTokenAccount = ctx.positionTokenAccount.toBase58();
      } catch {
        // best-effort
      }
      const collateralAmount = rawToUiAmount(collateralRaw, jupiterAccountingDecimals(market.decimals));
      const debtAmount = rawToUiAmount(debtRaw, jupiterAccountingDecimals(6));
      const collateralUsd = prices[market.mint]?.usdPrice != null
        ? collateralAmount * prices[market.mint].usdPrice
        : null;
      const debtUsd = prices[market.borrowMint]?.usdPrice != null
        ? debtAmount * prices[market.borrowMint].usdPrice
        : debtAmount;
      const netUsd =
        collateralUsd !== null && debtUsd !== null
          ? collateralUsd - debtUsd
          : null;
      const rate = ratesByVaultId.get(market.vaultId);
      const annualYieldUsd =
        collateralUsd !== null && debtUsd !== null && rate
          ? (collateralUsd * rate.depositApy - debtUsd * rate.borrowAPY) / 100
          : null;
      const netApy =
        annualYieldUsd !== null && netUsd !== null && netUsd > 0
          ? (annualYieldUsd / netUsd) * 100
          : null;

      const result: VaultJupiterBorrowPosition = {
        protocol: "Jupiter" as const,
        vaultId: market.vaultId,
        positionId,
        market: `${market.symbol} / ${market.borrowSymbol}`,
        collateralSymbol: market.symbol,
        collateralMint: market.mint,
        collateralRaw,
        collateralAmount,
        borrowSymbol: market.borrowSymbol,
        borrowMint: market.borrowMint,
        debtRaw,
        debtAmount,
        collateralUsd,
        debtUsd,
        netUsd,
        depositApy: rate?.depositApy ?? null,
        borrowAPY: rate?.borrowAPY ?? null,
        netApy,
        tokenAccount: positionTokenAccount,
      };
      return result;
    }),
  );

  return positions.filter((position): position is VaultJupiterBorrowPosition => Boolean(position));
}

export async function buildJupiterBorrowCollateralDepositTx(args: {
  connection: Connection;
  vaultProgramId: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  vaultId: number;
  amountRaw: string;
  positionId: number;
}): Promise<BuiltJupiterBorrowDeposit> {
  const amount = new BN(args.amountRaw);
  if (amount.lte(new BN(0))) throw new Error("amountRaw must be greater than zero");

  const market = getCollateralMarket(args.vaultId);
  const collateralDecimals = market?.decimals ?? 9;
  const sourceBalance = market
    ? await getVaultCollateralBalanceRaw({
        connection: args.connection,
        vault: args.vault,
        mint: new PublicKey(market.mint),
      })
    : null;
  const operateAmount = clampOperateAmountForVaultBalance(amount, sourceBalance);
  if (operateAmount.lte(new BN(0))) {
    throw new Error(
      `amountRaw is below Jupiter Lend precision for vault ${args.vaultId} (${collateralDecimals} decimals)`,
    );
  }

  const [{ getOperateIx }, runtimeWeb3] = await Promise.all([loadJupiterBorrow(), loadRuntimeWeb3()]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");
  const sdkSigner = new runtimeWeb3.PublicKey(args.vault.toBase58());
  const built = await getOperateIx({
    vaultId: args.vaultId,
    positionId: args.positionId,
    colAmount: operateAmount,
    debtAmount: new BN(0),
    signer: sdkSigner as unknown as PublicKey,
    positionOwner: sdkSigner as unknown as PublicKey,
    connection: sdkConnection as unknown as Connection,
  });

  const cpiIxs = built.ixs.map((ix) =>
    wrapProtocolCpiIx({
      vaultProgramId: args.vaultProgramId,
      authority: args.authority,
      vault: args.vault,
      inner: {
        programId: ix.programId.toBase58(),
        keys: ix.keys.map((key) => ({
          pubkey: key.pubkey.toBase58(),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: ix.data,
      },
    }),
  );

  const { topUpIxs, topUpLamports, currentVaultLamports: currentLamports } =
    await planVaultTopUp({
      connection: args.connection,
      authority: args.authority,
      vault: args.vault,
      needsRent: built.ixs.length > 1,
    });

  const txs: BuiltJupiterBorrowDeposit["txs"] = cpiIxs.map((ix, index) => ({
      label: `jupiter_borrow_deposit_collateral_${index + 1}`,
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ...(index === 0 ? topUpIxs : []),
        ix,
      ],
    }));

  return {
    requiredPrograms: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    txs,
    alts: (built.addressLookupTableAccounts ?? []).map((alt) =>
      cloneAlt(alt as unknown as AddressLookupTableAccount),
    ),
    summary: {
      vaultId: args.vaultId,
      nftId: args.positionId,
      directCount: topUpIxs.length,
      cpiCount: cpiIxs.length,
      sdkIxCount: built.ixs.length,
      topUpLamports,
      currentVaultLamports: currentLamports,
      collateralDecimals,
      requestedAmountRaw: amount.toString(),
      operateAmount: operateAmount.toString(),
      sourceBalanceRaw: sourceBalance?.toString() ?? null,
      programs: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    },
  };
}

export async function buildJupiterBorrowCollateralWithdrawTx(args: {
  connection: Connection;
  vaultProgramId: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  vaultId: number;
  positionId: number;
}): Promise<BuiltJupiterBorrowDeposit> {
  const market = getCollateralMarket(args.vaultId);
  const collateralDecimals = market?.decimals ?? 9;

  const [{ getOperateIx, MAX_WITHDRAW_AMOUNT }, runtimeWeb3] = await Promise.all([
    loadJupiterBorrow(),
    loadRuntimeWeb3(),
  ]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");
  const sdkSigner = new runtimeWeb3.PublicKey(args.vault.toBase58());
  const built = await getOperateIx({
    vaultId: args.vaultId,
    positionId: args.positionId,
    colAmount: MAX_WITHDRAW_AMOUNT,
    debtAmount: new BN(0),
    signer: sdkSigner as unknown as PublicKey,
    positionOwner: sdkSigner as unknown as PublicKey,
    connection: sdkConnection as unknown as Connection,
  });

  // Split: any setup ixs run directly with authority as signer (so the
  // System program can fund new accounts from a data-less wallet), the
  // final operate ix runs as CPI through the vault PDA. Same pattern as
  // repay — needed because Jupiter's InitTickIdLiquidation rejects
  // "Transfer: from must not carry data" when funded from vault PDA.
  const directIxs = built.ixs
    .slice(0, -1)
    .map((ix) => replaceVaultSignerWithAuthority(normalizeIx(ix), args.vault, args.authority));
  const operateIx = built.ixs[built.ixs.length - 1];
  const cpiIxs = operateIx
    ? [
        wrapProtocolCpiIx({
          vaultProgramId: args.vaultProgramId,
          authority: args.authority,
          vault: args.vault,
          inner: {
            programId: operateIx.programId.toBase58(),
            keys: operateIx.keys.map((key) => ({
              pubkey: key.pubkey.toBase58(),
              isSigner: key.isSigner,
              isWritable: key.isWritable,
            })),
            data: operateIx.data,
          },
        }),
      ]
    : [];

  const { topUpIxs, topUpLamports, currentVaultLamports: currentLamports } =
    await planVaultTopUp({
      connection: args.connection,
      authority: args.authority,
      vault: args.vault,
      needsRent: built.ixs.length > 1,
    });
  const txs: BuiltJupiterBorrowDeposit["txs"] = [
    ...directIxs.map((ix, index) => ({
      label: `jupiter_withdraw_setup_${index + 1}`,
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ...(index === 0 ? topUpIxs : []),
        ix,
      ],
    })),
    ...cpiIxs.map((ix, index) => ({
      label: `jupiter_borrow_withdraw_collateral_${index + 1}`,
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ...(directIxs.length === 0 && index === 0 ? topUpIxs : []),
        ix,
      ],
    })),
  ];

  return {
    requiredPrograms: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    txs,
    alts: (built.addressLookupTableAccounts ?? []).map((alt) =>
      cloneAlt(alt as unknown as AddressLookupTableAccount),
    ),
    summary: {
      vaultId: args.vaultId,
      nftId: args.positionId,
      directCount: directIxs.length + topUpIxs.length,
      cpiCount: cpiIxs.length,
      sdkIxCount: built.ixs.length,
      topUpLamports,
      currentVaultLamports: currentLamports,
      collateralDecimals,
      requestedAmountRaw: "MAX_WITHDRAW_AMOUNT",
      operateAmount: MAX_WITHDRAW_AMOUNT.toString(),
      sourceBalanceRaw: null,
      programs: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    },
  };
}

export async function buildJupiterBorrowUsdcBorrowTx(args: {
  connection: Connection;
  vaultProgramId: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  vaultId: number;
  positionId: number;
  amountRaw: string;
}): Promise<BuiltJupiterBorrowDeposit> {
  const amount = new BN(args.amountRaw);
  if (amount.lte(new BN(0))) throw new Error("amountRaw must be greater than zero");

  const market = getCollateralMarket(args.vaultId);
  const collateralDecimals = market?.decimals ?? 9;

  const [{ getOperateIx }, runtimeWeb3] = await Promise.all([loadJupiterBorrow(), loadRuntimeWeb3()]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");
  const sdkSigner = new runtimeWeb3.PublicKey(args.vault.toBase58());
  const built = await getOperateIx({
    vaultId: args.vaultId,
    positionId: args.positionId,
    colAmount: new BN(0),
    debtAmount: amount,
    signer: sdkSigner as unknown as PublicKey,
    positionOwner: sdkSigner as unknown as PublicKey,
    connection: sdkConnection as unknown as Connection,
  });

  const cpiIxs = built.ixs.map((ix) =>
    wrapProtocolCpiIx({
      vaultProgramId: args.vaultProgramId,
      authority: args.authority,
      vault: args.vault,
      inner: {
        programId: ix.programId.toBase58(),
        keys: ix.keys.map((key) => ({
          pubkey: key.pubkey.toBase58(),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: ix.data,
      },
    }),
  );

  const { topUpIxs, topUpLamports, currentVaultLamports: currentLamports } =
    await planVaultTopUp({
      connection: args.connection,
      authority: args.authority,
      vault: args.vault,
      needsRent: built.ixs.length > 1,
    });
  const txs: BuiltJupiterBorrowDeposit["txs"] = cpiIxs.map((ix, index) => ({
    label: `jupiter_borrow_usdc_${index + 1}`,
    ixs: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ...(index === 0 ? topUpIxs : []),
      ix,
    ],
  }));

  return {
    requiredPrograms: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    txs,
    alts: (built.addressLookupTableAccounts ?? []).map((alt) =>
      cloneAlt(alt as unknown as AddressLookupTableAccount),
    ),
    summary: {
      vaultId: args.vaultId,
      nftId: args.positionId,
      directCount: topUpIxs.length,
      cpiCount: cpiIxs.length,
      sdkIxCount: built.ixs.length,
      topUpLamports,
      currentVaultLamports: currentLamports,
      collateralDecimals,
      requestedAmountRaw: amount.toString(),
      operateAmount: amount.toString(),
      sourceBalanceRaw: null,
      programs: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    },
  };
}

export async function buildJupiterBorrowUsdcRepayTx(args: {
  connection: Connection;
  vaultProgramId: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  vaultId: number;
  positionId: number;
  amountRaw: string;
  /** Repay the full outstanding debt. Avoids VAULT_USER_DEBT_TOO_LOW when
   *  on-chain debt has drifted below the UI-displayed amount due to interest
   *  accrual or rounding. */
  max?: boolean;
}): Promise<BuiltJupiterBorrowDeposit> {
  const amount = new BN(args.amountRaw);
  if (!args.max && amount.lte(new BN(0))) {
    throw new Error("amountRaw must be greater than zero");
  }

  const market = getCollateralMarket(args.vaultId);
  const collateralDecimals = market?.decimals ?? 9;

  const [{ getOperateIx, getCurrentPosition }, runtimeWeb3] = await Promise.all([
    loadJupiterBorrow(),
    loadRuntimeWeb3(),
  ]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");
  const sdkSigner = new runtimeWeb3.PublicKey(args.vault.toBase58());
  // For "max": Jupiter stores debt internally in 9-decimal scaled
  // precision, and getOperateContext upscales the user input by
  // 10^(9 - tokenDecimals) before passing it to the operate ix. The
  // chain compares the *scaled* value with the stored debtRaw. So to
  // ask for a full repay we read current debtRaw and scale it DOWN by
  // the same factor: the SDK then scales it back up and the chain math
  // matches exactly.
  //
  // The SDK's MAX_REPAY_AMOUNT (= MIN_I128) sentinel is NOT a valid
  // operate amount on chain (rejected with VAULT_INVALID_OPERATE_AMOUNT).
  // And passing the raw 9-decimal debtRaw straight through gets it
  // multiplied a second time → VAULT_EXCESS_DEBT_PAYBACK.
  let debtArg: BN;
  if (args.max) {
    const current = await getCurrentPosition({
      vaultId: args.vaultId,
      positionId: args.positionId,
      connection: sdkConnection as unknown as Connection,
    });
    const debtRawScaled = new BN(current.debtRaw.toString());
    const dustDebtRaw = new BN(current.dustDebtRaw.toString());
    // The chain's "effective" debt is debtRaw - dustDebtRaw; the dust
    // portion is ignored by the operate validator. Compare against that.
    const netDebtScaled = debtRawScaled.gt(dustDebtRaw)
      ? debtRawScaled.sub(dustDebtRaw)
      : new BN(0);
    if (netDebtScaled.lte(new BN(0))) {
      throw new Error("Position has no outstanding debt to repay");
    }
    // All Jupiter xStocks markets borrow USDC (6 decimals) → scale factor 1000.
    const BORROW_DECIMALS = 6;
    const scalingPower = Math.max(0, 9 - BORROW_DECIMALS);
    const scaleDivisor = new BN(10).pow(new BN(scalingPower));
    let userDebtRaw = netDebtScaled.div(scaleDivisor);
    // Several off-by-one(s) stack up between the SDK's payback +1, dust
    // accruing between fetch and simulation, and rounding from the
    // 1000× scale. Pay 100 raw user-units (≈ $0.0001 USDC) less than
    // computed netDebt to absorb all of them. The residual dust stays
    // well below dustDebtRaw, and the chain treats the position as
    // fully cleared for the subsequent collateral withdraw.
    const safety = new BN(100);
    if (userDebtRaw.lte(safety)) {
      throw new Error("Position has no outstanding debt to repay");
    }
    userDebtRaw = userDebtRaw.sub(safety);
    debtArg = userDebtRaw.neg();
  } else {
    debtArg = amount.neg();
  }
  const built = await getOperateIx({
    vaultId: args.vaultId,
    positionId: args.positionId,
    colAmount: new BN(0),
    debtAmount: debtArg,
    signer: sdkSigner as unknown as PublicKey,
    positionOwner: sdkSigner as unknown as PublicKey,
    connection: sdkConnection as unknown as Connection,
  });

  const directIxs = built.ixs
    .slice(0, -1)
    .map((ix) => replaceVaultSignerWithAuthority(normalizeIx(ix), args.vault, args.authority));
  const operateIx = built.ixs[built.ixs.length - 1];
  const cpiIxs = operateIx ? [
    wrapProtocolCpiIx({
      vaultProgramId: args.vaultProgramId,
      authority: args.authority,
      vault: args.vault,
      inner: {
        programId: operateIx.programId.toBase58(),
        keys: operateIx.keys.map((key) => ({
          pubkey: key.pubkey.toBase58(),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: operateIx.data,
      },
    }),
  ] : [];

  // Repay setup may invoke Jupiter's InitTickIdLiquidation which creates a
  // new rent-paying account funded by the vault PDA via invoke_signed. If
  // the PDA is under-funded the simulation fails with
  // "Transaction results in an account (0) with insufficient funds for rent".
  const { topUpIxs, topUpLamports, currentVaultLamports: currentLamports } =
    await planVaultTopUp({
      connection: args.connection,
      authority: args.authority,
      vault: args.vault,
      needsRent: built.ixs.length > 1,
    });

  const txs: BuiltJupiterBorrowDeposit["txs"] = [
    ...directIxs.map((ix, index) => ({
      label: `jupiter_repay_setup_${index + 1}`,
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ...(index === 0 ? topUpIxs : []),
        ix,
      ],
    })),
    ...cpiIxs.map((ix, index) => ({
      label: `jupiter_repay_usdc_${index + 1}`,
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ix,
      ],
    })),
  ];

  return {
    requiredPrograms: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    txs,
    alts: (built.addressLookupTableAccounts ?? []).map((alt) =>
      cloneAlt(alt as unknown as AddressLookupTableAccount),
    ),
    summary: {
      vaultId: args.vaultId,
      nftId: args.positionId,
      directCount: directIxs.length + topUpIxs.length,
      cpiCount: cpiIxs.length,
      sdkIxCount: built.ixs.length,
      topUpLamports,
      currentVaultLamports: currentLamports,
      collateralDecimals,
      requestedAmountRaw: args.max ? "MAX_REPAY_AMOUNT" : amount.toString(),
      operateAmount: debtArg.toString(),
      sourceBalanceRaw: null,
      programs: [JUPITER_LEND_PROGRAM_ID.toBase58()],
    },
  };
}

export async function buildJupiterBorrowInitPositionSetupTx(args: {
  connection: Connection;
  authority: PublicKey;
  vault: PublicKey;
  vaultId: number;
}): Promise<BuiltJupiterBorrowInitPosition> {
  const [{ getInitPositionIx, getInitPositionContext }, runtimeWeb3] = await Promise.all([
    loadJupiterBorrow(),
    loadRuntimeWeb3(),
  ]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");
  const sdkAuthority = new runtimeWeb3.PublicKey(args.authority.toBase58());
  const init = await getInitPositionIx({
    vaultId: args.vaultId,
    connection: sdkConnection as unknown as Connection,
    signer: sdkAuthority as unknown as PublicKey,
  });

  const initContext = getInitPositionContext(args.vaultId, init.nftId, sdkAuthority as unknown as PublicKey);
  const positionMint = new PublicKey(initContext.positionMint.toBase58());
  const executorPositionAta = new PublicKey(initContext.positionTokenAccount.toBase58());
  const vaultPositionAta = getAssociatedTokenAddressSync(positionMint, args.vault, true, TOKEN_PROGRAM_ID);

  return {
    nftId: init.nftId,
    tx: {
      label: "jupiter_borrow_init_position",
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        normalizeIx(init.ix as unknown as TransactionInstruction),
        createAssociatedTokenAccountIdempotentInstruction(
          args.authority,
          vaultPositionAta,
          args.vault,
          positionMint,
          TOKEN_PROGRAM_ID,
        ),
        createTransferCheckedInstruction(
          executorPositionAta,
          positionMint,
          vaultPositionAta,
          args.authority,
          BigInt(1),
          0,
          [],
          TOKEN_PROGRAM_ID,
        ),
      ],
    },
  };
}
