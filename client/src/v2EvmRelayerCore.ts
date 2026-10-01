import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { AnchorProvider, BorshAccountsCoder, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import { getAccount, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  EVM_DEVNET_PROGRAM as programId, EVM_DEVNET_USDC_MINT as mint, EVM_DEVNET_GENESIS as genesis,
  deriveEvmSafe, parseEvmOwnerIntent, verifyEvmIntentSignature, isWithdrawalIntent, isLifecycleIntent, type EvmOwnerIntent,
} from "../../web/src/lib/v2EvmDevnet.ts";

const idl = JSON.parse(readFileSync(new URL("../../web/src/idl/yield_vault_evm_devnet.json", import.meta.url), "utf8")) as Idl;
const coder = new BorshAccountsCoder(idl);
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], loader);
export type RelayPolicy = {
  expectedElfSha256: string; expectedElfBytes: number; allowedOwners: string[]; allowLifecycle: boolean;
  maxFeeLamports: number; maxRentLamports: number; maxDailyLamports: number;
  maxHourlyTransactions: number; minBalanceLamports: number;
};
export type RelayPlan = {
  id: string; action: string; cluster: "devnet"; payer: string; program: string; safe: string;
  nonce: string; deadline: string; source: string; amountRaw: string;
  recipientTokenAccount?: string; recipientOwner?: string;
  sourceBeforeRaw: string; sourceAfterRaw: string; recipientBeforeRaw: string; recipientAfterRaw: string;
  feeLamports: number; rentLamports: number; costLamports: number; computeUnits?: number;
  deployedSha256: string; upgradeAuthority: string | null;
};
export function pinnedProgramHash(data: Buffer, policy: Pick<RelayPolicy, "expectedElfBytes" | "expectedElfSha256">) {
  const size = policy.expectedElfBytes;
  assert(Number.isSafeInteger(size) && size > 0 && data.length >= 45 + size, "unexpected program binary size");
  assert(data.subarray(45 + size).every(byte => byte === 0), "nonzero program padding; sponsor paused");
  const hash = createHash("sha256").update(data.subarray(45, 45 + size)).digest("hex");
  assert.equal(hash, policy.expectedElfSha256, "program binary changed; sponsor paused"); return hash;
}
function state(data: Buffer, ownerBytes: Uint8Array) {
  assert.equal(data.length, 705, "unexpected EvmVault layout");
  const v = coder.decode("EvmVault", data) as { eth_address: number[]; nonce: BN };
  assert(Buffer.from(v.eth_address).equals(Buffer.from(ownerBytes)), "Safe EVM owner mismatch"); return v;
}
function simulatedAccount(a: { owner: string; data: string[]; lamports: number } | null) {
  assert(a && a.data.length === 2 && a.data[1] === "base64", "simulation account missing or invalid encoding"); return { owner: new PublicKey(a.owner), data: Buffer.from(a.data[0], "base64"), lamports: a.lamports };
}
export async function buildRelayInstruction(connection: Connection, intent: EvmOwnerIntent, payer: PublicKey) {
  const { safe, ata, ownerBytes } = deriveEvmSafe(intent.owner);
  const program = new Program(idl, new AnchorProvider(connection, new Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const args = [new BN(intent.nonce), new BN(intent.deadline), [...Buffer.from(intent.signature.slice(2), "hex")]] as const;
  if (isLifecycleIntent(intent)) {
    if (intent.action === "create_safe") return program.methods.createEvmSafeAuthorized([...ownerBytes], ...args).accountsStrict({ payer, evmVault: safe, usdcMint: mint, vaultUsdcAta: ata, tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }).instruction();
    return program.methods.evmCancelIntents(...args).accountsStrict({ payer, evmVault: safe }).instruction();
  }
  if (isWithdrawalIntent(intent)) return program.methods.evmWithdrawUsdc(new BN(intent.amountRaw), ...args).accountsStrict({ payer, evmVault: safe, usdcMint: mint, vaultUsdcAta: ata, recipientUsdcAccount: new PublicKey(intent.recipientTokenAccount), tokenProgram: TOKEN_PROGRAM_ID }).instruction();
  return program.methods.evmSetAllocation(intent.allocationBps, ...args).accountsStrict({ payer, evmVault: safe }).instruction();
}

/** Public inputs only: does not load any Solana signer. One typed instruction, pinned code and fees. */
export async function prepareRelay(connection: Connection, input: Record<string, unknown>, payer: PublicKey, policy: RelayPolicy) {
  const intent = parseEvmOwnerIntent(input), digest = await verifyEvmIntentSignature(intent);
  assert(policy.allowedOwners.some(x => x.toLowerCase() === intent.owner.toLowerCase()), "owner is outside sponsor allowlist");
  const now = BigInt(Math.floor(Date.now() / 1000)), deadline = BigInt(intent.deadline);
  assert(deadline > now && deadline <= now + 900n, "intent expired or deadline too far away");
  assert.equal(await connection.getGenesisHash(), genesis, "RPC is not Devnet");
  const [executable, pd, payerInfo] = await connection.getMultipleAccountsInfo([programId, programData, payer], "confirmed");
  assert(executable && executable.executable && executable.owner.equals(loader) && executable.data.readUInt32LE(0) === 2 && new PublicKey(executable.data.subarray(4)).equals(programData));
  assert(pd && pd.owner.equals(loader) && pd.data.readUInt32LE(0) === 3 && pd.data.length >= 45);
  const deployedSha256 = pinnedProgramHash(pd.data, policy);
  const upgradeAuthority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  assert.notEqual(payer.toBase58(), upgradeAuthority, "upgrade authority cannot be the service relayer");
  assert(payerInfo && payerInfo.owner.equals(SystemProgram.programId) && payerInfo.lamports >= policy.minBalanceLamports, "sponsor below reserve");
  const { safe, ata, ownerBytes } = deriveEvmSafe(intent.owner), info = await connection.getAccountInfo(safe, "confirmed");
  const lifecycle = isLifecycleIntent(intent), creation = lifecycle && intent.action === "create_safe";
  assert(!lifecycle || policy.allowLifecycle, "lifecycle disabled pending program upgrade");
  let sourceBefore = 0n, recipientBefore = 0n, rentCap = 0;
  if (creation) {
    assert(!info, "Safe already exists; re-read state"); assert.equal(intent.rentPayer, payer.toBase58(), "signed sponsor mismatch");
    rentCap = await connection.getMinimumBalanceForRentExemption(705) + await connection.getMinimumBalanceForRentExemption(165);
    assert(rentCap <= policy.maxRentLamports, "creation rent exceeds budget");
  } else {
    assert(info && info.owner.equals(programId), "Safe missing or unexpected program owner");
    const v = state(info.data, ownerBytes); assert.equal(BigInt(intent.nonce), BigInt(v.nonce.toString()) + 1n, "Safe nonce changed; fresh owner intent required");
    const token = await getAccount(connection, ata, "confirmed", TOKEN_PROGRAM_ID);
    assert(token.owner.equals(safe) && token.mint.equals(mint) && token.isInitialized && !token.isFrozen && !token.delegate && !token.closeAuthority, "invalid Safe token account");
    sourceBefore = token.amount;
  }
  if (isWithdrawalIntent(intent)) {
    const token = await getAccount(connection, new PublicKey(intent.recipientTokenAccount), "confirmed", TOKEN_PROGRAM_ID);
    assert(token.mint.equals(mint) && token.owner.equals(new PublicKey(intent.recipientOwner)) && token.isInitialized && !token.isFrozen, "recipient mint/authority/state mismatch");
    assert(BigInt(intent.amountRaw) <= sourceBefore, "insufficient idle USDC"); recipientBefore = token.amount;
  }
  const instruction = await buildRelayInstruction(connection, intent, payer);
  const block = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: payer, recentBlockhash: block.blockhash }).add(instruction);
  const fee = (await connection.getFeeForMessage(transaction.compileMessage(), "confirmed")).value;
  assert(fee !== null && fee <= policy.maxFeeLamports, "fee exceeds sponsor limit");
  const postKeys = [payer, safe, ata, ...(isWithdrawalIntent(intent) ? [new PublicKey(intent.recipientTokenAccount)] : [])];
  const simulation = await connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: postKeys.map(x => x.toBase58()) } });
  assert.equal(simulation.value.err, null, "on-chain simulation rejected owner intent");
  assert(simulation.value.accounts); const post = simulation.value.accounts.map(simulatedAccount);
  const rentLamports = payerInfo.lamports - post[0].lamports - fee;
  assert(Number.isSafeInteger(rentLamports) && rentLamports >= 0 && rentLamports <= rentCap, "unexpected payer debit");
  assert(post[1].owner.equals(programId)); assert.equal(state(post[1].data, ownerBytes).nonce.toString(), intent.nonce);
  const amount = isWithdrawalIntent(intent) ? BigInt(intent.amountRaw) : 0n;
  const tokenAmount = (data: Buffer) => { assert.equal(data.length, 165); return data.readBigUInt64LE(64); };
  assert.equal(tokenAmount(post[2].data), sourceBefore - amount, "simulation source balance mismatch");
  if (isWithdrawalIntent(intent)) assert.equal(tokenAmount(post[3].data), recipientBefore + amount, "simulation recipient balance mismatch");
  assert(payerInfo.lamports - fee - rentLamports >= policy.minBalanceLamports, "operation would consume sponsor reserve");
  const plan: RelayPlan = { id: digest, action: creation ? "create_safe" : lifecycle ? "cancel_intents" : isWithdrawalIntent(intent) ? "withdraw_usdc" : "set_allocation",
    cluster: "devnet", payer: payer.toBase58(), program: programId.toBase58(), safe: safe.toBase58(), nonce: intent.nonce, deadline: intent.deadline,
    source: ata.toBase58(), amountRaw: amount.toString(), sourceBeforeRaw: sourceBefore.toString(), sourceAfterRaw: (sourceBefore - amount).toString(),
    recipientBeforeRaw: recipientBefore.toString(), recipientAfterRaw: (recipientBefore + amount).toString(), feeLamports: fee, rentLamports,
    costLamports: fee + rentLamports, computeUnits: simulation.value.unitsConsumed, deployedSha256, upgradeAuthority,
    ...(isWithdrawalIntent(intent) ? { recipientTokenAccount: intent.recipientTokenAccount, recipientOwner: intent.recipientOwner } : {}) };
  return { intent, digest, transaction, block, plan };
}
export async function verifyRelayReceipt(connection: Connection, signature: string, intent: EvmOwnerIntent) {
  const receipt = await connection.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  assert(receipt && receipt.meta, "receipt unavailable; keep transaction reserved");
  const feeLamports = receipt.meta.fee;
  if (receipt.meta.err) return { success: false as const, slot: receipt.slot, costLamports: feeLamports };
  const payerRent = receipt.meta.preBalances[0] - receipt.meta.postBalances[0] - feeLamports;
  assert(payerRent >= 0, "unexpected receipt payer credit");
  const { safe, ata, ownerBytes } = deriveEvmSafe(intent.owner);
  const account = await connection.getAccountInfo(safe, { commitment: "finalized", minContextSlot: receipt.slot });
  assert(account && account.owner.equals(programId));
  // A later valid owner action may have already advanced the counter; the receipt remains authoritative.
  assert(BigInt(state(account.data, ownerBytes).nonce.toString()) >= BigInt(intent.nonce));
  if (isWithdrawalIntent(intent)) {
    const keys = receipt.transaction.message.getAccountKeys();
    const index = (address: string) => [...Array(keys.length).keys()].find(n => keys.get(n)?.toBase58() === address);
    for (const [address, sign] of [[ata.toBase58(), -1n], [intent.recipientTokenAccount, 1n]] as const) {
      const n = index(address);
    const pre: { mint: string; uiTokenAmount: { amount: string } } | undefined = receipt.meta.preTokenBalances?.find(x => x.accountIndex === n);
    const post: { mint: string; uiTokenAmount: { amount: string } } | undefined = receipt.meta.postTokenBalances?.find(x => x.accountIndex === n);
      assert(pre && post && pre.mint === mint.toBase58() && post.mint === mint.toBase58());
      assert.equal(BigInt(post.uiTokenAmount.amount) - BigInt(pre.uiTokenAmount.amount), sign * BigInt(intent.amountRaw));
    }
  }
  return { success: true as const, slot: receipt.slot, costLamports: feeLamports + payerRent };
}
