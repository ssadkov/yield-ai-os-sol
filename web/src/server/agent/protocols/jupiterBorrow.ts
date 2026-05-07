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
  unpackAccount,
} from "@solana/spl-token";
import { JUPITER_XSTOCKS_USDC_MARKETS, type JupiterBorrowCollateralMarket } from "@/lib/jupiterBorrowMarkets";
import { wrapProtocolCpiIx } from "./wrapCpi";

export const JUPITER_LEND_PROGRAM_ID = new PublicKey("jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi");

const COMPUTE_UNIT_LIMIT = 1_400_000;
const VAULT_PDA_LAMPORT_BUFFER = 50_000_000; // 0.05 SOL for Jupiter position/rent setup.

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

function getCollateralMarket(vaultId: number): JupiterBorrowCollateralMarket | undefined {
  return JUPITER_XSTOCKS_USDC_MARKETS.find((market) => market.vaultId === vaultId);
}

export async function findExistingVaultJupiterBorrowPosition(args: {
  connection: Connection;
  vault: PublicKey;
  vaultId: number;
  scanLimit?: number;
}): Promise<ExistingJupiterBorrowPosition | null> {
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

  const scannedFrom = Math.max(1, next.nftId - 1);
  const scannedTo = Math.max(1, next.nftId - (args.scanLimit ?? 100));
  const candidates: { positionId: number; tokenAccount: PublicKey }[] = [];
  for (let positionId = scannedFrom; positionId >= scannedTo; positionId--) {
    const context = getInitPositionContext(args.vaultId, positionId, sdkVault as unknown as PublicKey);
    candidates.push({
      positionId,
      tokenAccount: new PublicKey(context.positionTokenAccount.toBase58()),
    });
  }

  const accounts = await args.connection.getMultipleAccountsInfo(
    candidates.map((candidate) => candidate.tokenAccount),
    "confirmed",
  );
  for (let index = 0; index < candidates.length; index++) {
    const info = accounts[index];
    if (!info) continue;

    try {
      const account = unpackAccount(candidates[index].tokenAccount, info, TOKEN_PROGRAM_ID);
      if (account.owner.equals(args.vault) && account.amount === BigInt(1)) {
        return {
          positionId: candidates[index].positionId,
          tokenAccount: candidates[index].tokenAccount.toBase58(),
          scannedFrom,
          scannedTo,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
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
  tokenAccount: string;
};

export async function readVaultJupiterBorrowPositions(args: {
  connection: Connection;
  vault: PublicKey;
}): Promise<VaultJupiterBorrowPosition[]> {
  const [{ getCurrentPosition }, runtimeWeb3] = await Promise.all([loadJupiterBorrow(), loadRuntimeWeb3()]);
  const sdkConnection = new runtimeWeb3.Connection(args.connection.rpcEndpoint, "confirmed");

  const positions = await Promise.all(
    JUPITER_XSTOCKS_USDC_MARKETS.map(async (market) => {
      const existing = await findExistingVaultJupiterBorrowPosition({
        connection: args.connection,
        vault: args.vault,
        vaultId: market.vaultId,
      });
      if (!existing) return null;

      const current = await getCurrentPosition({
        vaultId: market.vaultId,
        positionId: existing.positionId,
        connection: sdkConnection as unknown as Connection,
      });
      const collateralRaw = current.colRaw.toString();
      const debtRaw = current.debtRaw.toString();
      if (BigInt(collateralRaw) === BigInt(0) && BigInt(debtRaw) === BigInt(0)) return null;

      return {
        protocol: "Jupiter" as const,
        vaultId: market.vaultId,
        positionId: existing.positionId,
        market: `${market.symbol} / ${market.borrowSymbol}`,
        collateralSymbol: market.symbol,
        collateralMint: market.mint,
        collateralRaw,
        collateralAmount: rawToUiAmount(collateralRaw, jupiterAccountingDecimals(market.decimals)),
        borrowSymbol: market.borrowSymbol,
        borrowMint: market.borrowMint,
        debtRaw,
        debtAmount: rawToUiAmount(debtRaw, jupiterAccountingDecimals(6)),
        tokenAccount: existing.tokenAccount,
      };
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

  const topUpIxs: TransactionInstruction[] = [];
  const currentLamports = await args.connection.getBalance(args.vault, "confirmed");
  const hasRentSetupIxs = built.ixs.length > 1;
  const topUpLamports = hasRentSetupIxs ? Math.max(0, VAULT_PDA_LAMPORT_BUFFER - currentLamports) : 0;
  if (topUpLamports > 0) {
    topUpIxs.push(
      SystemProgram.transfer({
        fromPubkey: args.authority,
        toPubkey: args.vault,
        lamports: topUpLamports,
      }),
    );
  }

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

  const currentLamports = await args.connection.getBalance(args.vault, "confirmed");
  const txs: BuiltJupiterBorrowDeposit["txs"] = cpiIxs.map((ix, index) => ({
    label: `jupiter_borrow_withdraw_collateral_${index + 1}`,
    ixs: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
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
      directCount: 0,
      cpiCount: cpiIxs.length,
      sdkIxCount: built.ixs.length,
      topUpLamports: 0,
      currentVaultLamports: currentLamports,
      collateralDecimals,
      requestedAmountRaw: "MAX_WITHDRAW_AMOUNT",
      operateAmount: MAX_WITHDRAW_AMOUNT.toString(),
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
