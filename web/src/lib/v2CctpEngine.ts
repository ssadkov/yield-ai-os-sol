import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  createPublicClient, decodeFunctionData, http, parseAbi, parseEventLogs,
  type Hex, type TransactionReceipt,
} from "viem";
import { baseSepolia } from "viem/chains";

// Anchor account:Vault discriminator, checked against the bundled v2 IDL.
const VAULT_DISCRIMINATOR = Buffer.from([211, 8, 232, 43, 2, 152, 117, 119]);

/** The first bridge route is deliberately limited to testnet. */
export const CCTP_TESTNET = {
  sourceDomain: 6,
  destinationDomain: 5,
  finalityThreshold: 1000,
  iris: "https://iris-api-sandbox.circle.com",
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as Hex,
  sourceUsdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Hex,
  destinationUsdc: new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
  program: new PublicKey("8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5"),
  genesis: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
} as const;
export const FORWARD_HOOK: Hex = "0x636374702d666f72776172640000000000000000000000000000000000000000";
export const ZERO_BYTES32: Hex = `0x${"00".repeat(32)}`;
export const CCTP_JOURNAL_KEY = "yield-v2-cctp-devnet-v1";
export const sourceClient = createPublicClient({ chain: baseSepolia, transport: http() });
export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
export const messengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

export type Recipient = { owner: string; safe: string; ata: string; balanceRaw: bigint };
export type FeeQuote = { protocolBps: number; forwardRaw: bigint; fetchedAt: number };
export type BridgeStage = "source_pending" | "circle_pending" | "destination_pending" | "settled" | "source_failed" | "destination_failed";
export type BridgeTransfer = {
  version: 1;
  sourceTxHash: Hex;
  sourceAddress: Hex;
  owner: string;
  safe: string;
  ata: string;
  amountRaw: string;
  maxFeeRaw: string;
  startedAt: number;
  stage: BridgeStage;
  eventNonce?: Hex;
  messageHash?: string;
  circleStatus?: string;
  forwardState?: string;
  forwardTxHash?: string;
  receivedRaw?: string;
};

export async function validateRecipient(connection: Connection, owner: PublicKey): Promise<Recipient> {
  if (await connection.getGenesisHash() !== CCTP_TESTNET.genesis) throw new Error("Solana RPC is not Devnet");
  const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], CCTP_TESTNET.program);
  const ata = getAssociatedTokenAddressSync(CCTP_TESTNET.destinationUsdc, safe, true);
  const [safeInfo, ataInfo] = await connection.getMultipleAccountsInfo([safe, ata], "confirmed");
  if (!safeInfo || !safeInfo.owner.equals(CCTP_TESTNET.program) ||
    !safeInfo.data.subarray(0, 8).equals(VAULT_DISCRIMINATOR) ||
    !safeInfo.data.subarray(9, 41).equals(owner.toBuffer())) {
    throw new Error("Connected Solana wallet does not own an initialized v2 Safe on Devnet");
  }
  if (!ataInfo || !ataInfo.owner.equals(TOKEN_PROGRAM_ID)) throw new Error("Safe USDC ATA is not initialized");
  const parsed = await connection.getParsedAccountInfo(ata, "confirmed");
  const token = (parsed.value?.data as { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string } } } })?.parsed?.info;
  if (token?.mint !== CCTP_TESTNET.destinationUsdc.toBase58() || token.owner !== safe.toBase58() ||
    !token.tokenAmount?.amount || !/^\d+$/.test(token.tokenAmount.amount)) {
    throw new Error("Safe ATA has the wrong USDC mint or owner");
  }
  return { owner: owner.toBase58(), safe: safe.toBase58(), ata: ata.toBase58(), balanceRaw: BigInt(token.tokenAmount.amount) };
}

export async function fetchFeeQuote(): Promise<FeeQuote> {
  const url = `${CCTP_TESTNET.iris}/v2/burn/USDC/fees/${CCTP_TESTNET.sourceDomain}/${CCTP_TESTNET.destinationDomain}?forward=true`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Circle fee quote HTTP ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) throw new Error("Circle fee quote is malformed");
  const row = rows.find((item) => item?.finalityThreshold === CCTP_TESTNET.finalityThreshold);
  if (!row || typeof row.minimumFee !== "number" || !Number.isFinite(row.minimumFee) || row.minimumFee < 0 ||
    !Number.isSafeInteger(row.forwardFee?.med) || row.forwardFee.med < 0) throw new Error("Circle fast fee quote is missing");
  return { protocolBps: row.minimumFee, forwardRaw: BigInt(row.forwardFee.med), fetchedAt: Date.now() };
}

/** maxFee is a ceiling; Circle may charge less. Amount is the total USDC burned. */
export function maxFeeRaw(amountRaw: bigint, quote: FeeQuote): bigint {
  if (amountRaw <= BigInt(0)) throw new Error("Amount must be positive");
  const bpsHundredths = Math.ceil(quote.protocolBps * 100);
  if (!Number.isSafeInteger(bpsHundredths) || bpsHundredths < 0) throw new Error("Invalid Circle protocol fee");
  const protocol = (amountRaw * BigInt(bpsHundredths) + BigInt(999_999)) / BigInt(1_000_000);
  const forwarding = (quote.forwardRaw * BigInt(12) + BigInt(9)) / BigInt(10);
  return protocol + forwarding;
}

export function mintRecipientBytes32(ata: string): Hex {
  return `0x${Buffer.from(new PublicKey(ata).toBytes()).toString("hex")}`;
}

export function isTxHash(value: string): value is Hex { return /^0x[0-9a-fA-F]{64}$/.test(value); }

/** MetaMask smart accounts can wrap the burn, so verify Circle's emitted event. */
export async function inspectSourceBurn(hash: Hex, recipient: Recipient): Promise<BridgeTransfer> {
  const receipt = await sourceClient.getTransactionReceipt({ hash });
  return decodeSourceBurnReceipt(receipt, hash, recipient);
}

export function decodeSourceBurnReceipt(
  receipt: Pick<TransactionReceipt, "logs" | "status">, hash: Hex, recipient: Recipient,
): BridgeTransfer {
  if (receipt.status !== "success") throw new Error("Source transaction did not succeed");
  const logs = parseEventLogs({ abi: messengerAbi, eventName: "DepositForBurn", logs: receipt.logs });
  const burns = logs.filter((log) => log.address.toLowerCase() === CCTP_TESTNET.tokenMessenger.toLowerCase());
  if (burns.length !== 1) throw new Error("Expected exactly one Circle burn event in the source transaction");
  const burn = burns[0].args;
  if (burn.destinationDomain !== CCTP_TESTNET.destinationDomain ||
    burn.mintRecipient.toLowerCase() !== mintRecipientBytes32(recipient.ata).toLowerCase() ||
    burn.burnToken.toLowerCase() !== CCTP_TESTNET.sourceUsdc.toLowerCase() ||
    burn.destinationCaller !== ZERO_BYTES32 || burn.minFinalityThreshold !== CCTP_TESTNET.finalityThreshold ||
    burn.hookData.toLowerCase() !== FORWARD_HOOK || burn.amount <= burn.maxFee) {
    throw new Error("Burn route, Safe ATA, token, or forwarding hook does not match");
  }
  return {
    version: 1, sourceTxHash: hash, sourceAddress: burn.depositor, owner: recipient.owner,
    safe: recipient.safe, ata: recipient.ata, amountRaw: burn.amount.toString(), maxFeeRaw: burn.maxFee.toString(),
    startedAt: Date.now(), stage: "source_pending",
  };
}

export function decodeSourceBurn(
  tx: { to: Hex | null; input: Hex; from: Hex }, hash: Hex, recipient: Recipient,
): BridgeTransfer {
  if (tx.to?.toLowerCase() !== CCTP_TESTNET.tokenMessenger.toLowerCase()) throw new Error("Source transaction is not the testnet TokenMessenger");
  const decoded = decodeFunctionData({ abi: messengerAbi, data: tx.input });
  if (decoded.functionName !== "depositForBurnWithHook") throw new Error("Source transaction is not a CCTP forwarding burn");
  const [amount, domain, mintRecipient, burnToken, destinationCaller, maxFee, finality, hook] = decoded.args;
  if (domain !== CCTP_TESTNET.destinationDomain || mintRecipient.toLowerCase() !== mintRecipientBytes32(recipient.ata).toLowerCase() ||
    burnToken.toLowerCase() !== CCTP_TESTNET.sourceUsdc.toLowerCase() || destinationCaller !== ZERO_BYTES32 ||
    finality !== CCTP_TESTNET.finalityThreshold || hook.toLowerCase() !== FORWARD_HOOK || amount <= maxFee) {
    throw new Error("Burn route, Safe ATA, token, or forwarding hook does not match");
  }
  return {
    version: 1, sourceTxHash: hash, sourceAddress: tx.from, owner: recipient.owner,
    safe: recipient.safe, ata: recipient.ata, amountRaw: amount.toString(), maxFeeRaw: maxFee.toString(),
    startedAt: Date.now(), stage: "source_pending",
  };
}

export function readJournal(storage: Pick<Storage, "getItem">): BridgeTransfer[] {
  try {
    const rows: unknown = JSON.parse(storage.getItem(CCTP_JOURNAL_KEY) || "[]");
    if (!Array.isArray(rows)) return [];
    return rows.filter((item): item is BridgeTransfer => item?.version === 1 && isTxHash(item.sourceTxHash) &&
      /^0x[0-9a-fA-F]{40}$/.test(item.sourceAddress) &&
      typeof item.owner === "string" && typeof item.safe === "string" && typeof item.ata === "string" &&
      typeof item.amountRaw === "string" && /^\d+$/.test(item.amountRaw) &&
      typeof item.maxFeeRaw === "string" && /^\d+$/.test(item.maxFeeRaw) &&
      typeof item.startedAt === "number" && Number.isFinite(item.startedAt) &&
      ["source_pending", "circle_pending", "destination_pending", "settled", "source_failed", "destination_failed"].includes(item.stage)).slice(0, 20);
  } catch { return []; }
}

export function saveJournal(storage: Pick<Storage, "getItem" | "setItem">, transfer: BridgeTransfer): BridgeTransfer[] {
  const rows = [transfer, ...readJournal(storage).filter((item) => item.sourceTxHash.toLowerCase() !== transfer.sourceTxHash.toLowerCase())]
    .sort((a, b) => b.startedAt - a.startedAt).slice(0, 20);
  storage.setItem(CCTP_JOURNAL_KEY, JSON.stringify(rows));
  return rows;
}

export function mintedToAta(tx: NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>, ata: string): bigint {
  const keys = tx.transaction.message.accountKeys;
  const index = keys.findIndex((key) => key.pubkey.toBase58() === ata);
  if (index < 0 || !tx.meta) return BigInt(0);
  const mint = CCTP_TESTNET.destinationUsdc.toBase58();
  const before = tx.meta.preTokenBalances?.find((item) => item.accountIndex === index && item.mint === mint);
  const after = tx.meta.postTokenBalances?.find((item) => item.accountIndex === index && item.mint === mint);
  if (!after) return BigInt(0);
  const delta = BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount || "0");
  return delta > BigInt(0) ? delta : BigInt(0);
}

/** Read-only reconciliation: Circle's status alone never credits a transfer. */
export async function refreshTransfer(connection: Connection, transfer: BridgeTransfer): Promise<BridgeTransfer> {
  if (transfer.stage === "settled" || transfer.stage === "source_failed" || transfer.stage === "destination_failed") return transfer;
  const receipt = await sourceClient.getTransactionReceipt({ hash: transfer.sourceTxHash }).catch(() => null);
  if (!receipt) return transfer;
  if (receipt.status !== "success") return { ...transfer, stage: "source_failed" };
  const source = decodeSourceBurnReceipt(receipt, transfer.sourceTxHash, {
    owner: transfer.owner, safe: transfer.safe, ata: transfer.ata, balanceRaw: BigInt(0),
  });
  if (source.amountRaw !== transfer.amountRaw || source.maxFeeRaw !== transfer.maxFeeRaw ||
    source.sourceAddress.toLowerCase() !== transfer.sourceAddress.toLowerCase()) {
    throw new Error("Stored burn differs from the Base Sepolia transaction");
  }
  const response = await fetch(`${CCTP_TESTNET.iris}/v2/messages/${CCTP_TESTNET.sourceDomain}?transactionHash=${transfer.sourceTxHash}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Circle status HTTP ${response.status}`);
  const body: { messages?: { eventNonce?: string; messageHash?: string; status?: string; forwardState?: string; forwardTxHash?: string }[] } = await response.json();
  if (!Array.isArray(body.messages) || body.messages.length === 0) return { ...transfer, stage: "circle_pending" };
  if (body.messages.length !== 1) throw new Error("Multiple Circle messages in one burn; manual review required");
  const message = body.messages[0];
  const next = { ...transfer, stage: "destination_pending" as BridgeStage,
    eventNonce: message.eventNonce && isTxHash(message.eventNonce) ? message.eventNonce : undefined,
    messageHash: message.messageHash, circleStatus: message.status, forwardState: message.forwardState };
  if (!message.forwardTxHash) return next;
  next.forwardTxHash = message.forwardTxHash;
  const tx = await connection.getParsedTransaction(message.forwardTxHash, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!tx) return next;
  if (tx.meta?.err) return { ...next, stage: "destination_failed" };
  const received = mintedToAta(tx, transfer.ata);
  if (received <= BigInt(0)) throw new Error("Forward transaction has no USDC mint into this Safe ATA");
  if (received < BigInt(transfer.amountRaw) - BigInt(transfer.maxFeeRaw)) {
    throw new Error("Minted USDC is below the owner-approved minimum; manual review required");
  }
  return { ...next, stage: "settled", receivedRaw: received.toString() };
}
