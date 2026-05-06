import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { wrapProtocolCpiIx } from "./wrapCpi";

export const KAMINO_KVAULT_PROGRAM_ID = new PublicKey("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd");
export const KAMINO_KLEND_PROGRAM_ID = new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
export const KAMINO_FARMS_PROGRAM_ID = new PublicKey("FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr");

const KAMINO_API_BASE = "https://api.kamino.finance";
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const COMPUTE_UNIT_LIMIT = 1_400_000;

type KaminoAccountRole = "WRITABLE_SIGNER" | "READONLY_SIGNER" | "WRITABLE" | "READONLY";

type KaminoInstructionAccount = {
  address: string;
  role: KaminoAccountRole;
};

type KaminoInstruction = {
  accounts: KaminoInstructionAccount[];
  data: string;
  programAddress: string;
};

type KaminoDepositInstructionsResponse = {
  instructions: KaminoInstruction[];
  lutsByAddress?: Record<string, string[]>;
};

type KaminoKvaultAction = "deposit" | "withdraw";

function roleToMeta(role: KaminoAccountRole): { isSigner: boolean; isWritable: boolean } {
  return {
    isSigner: role.includes("SIGNER"),
    isWritable: role.includes("WRITABLE"),
  };
}

function instructionToWeb3(ix: KaminoInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((account) => ({
      pubkey: new PublicKey(account.address),
      ...roleToMeta(account.role),
    })),
    data: Buffer.from(ix.data, "base64"),
  });
}

function lutsFromKamino(raw: Record<string, string[]> | undefined): AddressLookupTableAccount[] {
  if (!raw) return [];
  return Object.entries(raw).map(([key, addresses]) => {
    return new AddressLookupTableAccount({
      key: new PublicKey(key),
      state: {
        deactivationSlot: BigInt("18446744073709551615"),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: addresses.map((address) => new PublicKey(address)),
      },
    });
  });
}

function transformPayerAccounts(args: {
  ix: KaminoInstruction;
  vault: PublicKey;
  authority: PublicKey;
}): KaminoInstruction {
  const vaultAddress = args.vault.toBase58();
  const authorityAddress = args.authority.toBase58();
  const program = args.ix.programAddress;

  const accounts = args.ix.accounts.map((account, index) => {
    const isVaultSigner = account.address === vaultAddress && account.role.includes("SIGNER");

    // Kamino KTX uses the wallet as the payer for ATA creation. Our wallet is a
    // program-owned PDA, so it cannot pay System Program rent. Make the backend
    // executor pay while keeping the ATA owner as the vault PDA.
    if (program === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58() && index === 0 && isVaultSigner) {
      return { ...account, address: authorityAddress };
    }

    // Farm initialization uses the wallet as both farm authority and payer.
    // Keep readonly signer authority accounts as the vault PDA, but move the
    // writable signer payer slot to the backend executor.
    if (program === KAMINO_FARMS_PROGRAM_ID.toBase58() && account.role === "WRITABLE_SIGNER" && isVaultSigner) {
      return { ...account, address: authorityAddress };
    }

    return account;
  });

  return { ...args.ix, accounts };
}

function shouldSendDirect(ix: KaminoInstruction): boolean {
  return ix.programAddress === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58();
}

export type BuiltKaminoKvaultAction = {
  requiredPrograms: string[];
  txs: {
    label: string;
    ixs: TransactionInstruction[];
  }[];
  alts: AddressLookupTableAccount[];
  summary: {
    directCount: number;
    cpiCount: number;
    skippedFarmCount: number;
    programs: string[];
  };
};

async function buildKaminoKvaultActionTx(args: {
  action: KaminoKvaultAction;
  connection: Connection;
  vaultProgramId: PublicKey;
  authority: PublicKey;
  vault: PublicKey;
  kvault: PublicKey;
  amount: string;
}): Promise<BuiltKaminoKvaultAction> {
  const response = await fetch(`${KAMINO_API_BASE}/ktx/kvault/${args.action}-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      wallet: args.vault.toBase58(),
      kvault: args.kvault.toBase58(),
      amount: args.amount,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Kamino kVault ${args.action} instruction build failed (${response.status}): ${body.slice(0, 500)}`);
  }

  const payload = (await response.json()) as KaminoDepositInstructionsResponse;
  const directIxs: TransactionInstruction[] = [];
  const actionCpiIxs: TransactionInstruction[] = [];
  let skippedFarmCount = 0;
  const requiredPrograms = new Set<string>();

  for (const rawIx of payload.instructions) {
    const ix = transformPayerAccounts({
      ix: rawIx,
      vault: args.vault,
      authority: args.authority,
    });

    if (shouldSendDirect(ix)) {
      directIxs.push(instructionToWeb3(ix));
      continue;
    }

    // kVault actions may include optional farm instructions for rewards.
    // Non-delegated kFarms require user/user_ref/authority/payer to all be the
    // same signer, which does not fit the vault-PDA + backend-payer model. The
    // base kVault action is sufficient for the Earn position, so skip farms
    // until delegated farm support is wired explicitly.
    if (ix.programAddress === KAMINO_FARMS_PROGRAM_ID.toBase58()) {
      skippedFarmCount++;
      continue;
    }

    requiredPrograms.add(ix.programAddress);
    const wrapped = wrapProtocolCpiIx({
        vaultProgramId: args.vaultProgramId,
        authority: args.authority,
        vault: args.vault,
        inner: {
          programId: ix.programAddress,
          keys: ix.accounts.map((account) => ({
            pubkey: account.address,
            ...roleToMeta(account.role),
          })),
          data: ix.data,
        },
      });

    actionCpiIxs.push(wrapped);
  }

  if (actionCpiIxs.length === 0) {
    throw new Error(`Kamino returned no kVault ${args.action} CPI instructions`);
  }

  const txs: BuiltKaminoKvaultAction["txs"] = [];
  if (directIxs.length > 0 || actionCpiIxs.length > 0) {
    txs.push({
      label: `kamino_kvault_${args.action}`,
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ...directIxs,
        ...actionCpiIxs,
      ],
    });
  }

  return {
    requiredPrograms: [...requiredPrograms],
    txs,
    alts: lutsFromKamino(payload.lutsByAddress),
    summary: {
      directCount: directIxs.length,
      cpiCount: actionCpiIxs.length,
      skippedFarmCount,
      programs: [...requiredPrograms],
    },
  };
}

export function buildKaminoKvaultDepositTx(args: Omit<Parameters<typeof buildKaminoKvaultActionTx>[0], "action">) {
  return buildKaminoKvaultActionTx({ ...args, action: "deposit" });
}

export function buildKaminoKvaultWithdrawTx(args: Omit<Parameters<typeof buildKaminoKvaultActionTx>[0], "action">) {
  return buildKaminoKvaultActionTx({ ...args, action: "withdraw" });
}
