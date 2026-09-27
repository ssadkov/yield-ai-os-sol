import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData } from "viem";
import {
  CCTP_TESTNET, FORWARD_HOOK, ZERO_BYTES32, CCTP_JOURNAL_KEY,
  decodeSourceBurn, decodeSourceBurnReceipt, maxFeeRaw, messengerAbi, mintedToAta, mintRecipientBytes32,
  readJournal, saveJournal,
} from "../src/lib/v2CctpEngine.ts";

const owner = new PublicKey("2twCpxj6cqztdXwgV7EabmtDnC7W7xGr12hNrEuxpcdj");
const [safe] = PublicKey.findProgramAddressSync([Buffer.from("vault"), owner.toBuffer()], CCTP_TESTNET.program);
const ata = getAssociatedTokenAddressSync(CCTP_TESTNET.destinationUsdc, safe, true);
const recipient = { owner: owner.toBase58(), safe: safe.toBase58(), ata: ata.toBase58(), balanceRaw: BigInt(0) };
const from = "0x1111111111111111111111111111111111111111";
const hash = `0x${"a".repeat(64)}`;

test("vault discriminator agrees with the bundled program IDL", () => {
  const idl = JSON.parse(readFileSync(new URL("../src/idl/yield_vault.json", import.meta.url)));
  assert.deepEqual(idl.accounts.find((account) => account.name === "Vault").discriminator, [211, 8, 232, 43, 2, 152, 117, 119]);
});

test("quote ceiling uses exact raw USDC and is higher than the displayed forwarding quote", () => {
  const ceiling = maxFeeRaw(BigInt(2_000_000), { protocolBps: 1.3, forwardRaw: BigInt(143_754), fetchedAt: 0 });
  assert.equal(ceiling, BigInt(172_765));
  assert.throws(() => maxFeeRaw(BigInt(0), { protocolBps: 1.3, forwardRaw: BigInt(143_754), fetchedAt: 0 }));
});

test("recovered burn must target the exact Safe ATA with the forwarding hook", () => {
  const args = [BigInt(2_000_000), CCTP_TESTNET.destinationDomain, mintRecipientBytes32(recipient.ata),
    CCTP_TESTNET.sourceUsdc, ZERO_BYTES32, BigInt(172_765), CCTP_TESTNET.finalityThreshold, FORWARD_HOOK];
  const input = encodeFunctionData({ abi: messengerAbi, functionName: "depositForBurnWithHook", args });
  const transfer = decodeSourceBurn({ to: CCTP_TESTNET.tokenMessenger, input, from }, hash, recipient);
  assert.equal(transfer.ata, recipient.ata);
  assert.equal(transfer.amountRaw, "2000000");
  assert.throws(() => decodeSourceBurn({ to: CCTP_TESTNET.tokenMessenger, input, from }, hash,
    { ...recipient, ata: owner.toBase58() }), /Safe ATA/);
  assert.throws(() => decodeSourceBurn({ to: CCTP_TESTNET.sourceUsdc, input, from }, hash, recipient), /TokenMessenger/);
  const noHook = encodeFunctionData({ abi: messengerAbi, functionName: "depositForBurnWithHook", args: [...args.slice(0, 7), "0x"] });
  assert.throws(() => decodeSourceBurn({ to: CCTP_TESTNET.tokenMessenger, input: noHook, from }, hash, recipient), /forwarding hook/);
});

test("smart-account wrapper is tracked by the authentic Circle burn event", () => {
  const depositor = "0x2222222222222222222222222222222222222222";
  const log = {
    address: CCTP_TESTNET.tokenMessenger,
    topics: encodeEventTopics({ abi: messengerAbi, eventName: "DepositForBurn",
      args: { burnToken: CCTP_TESTNET.sourceUsdc, depositor, minFinalityThreshold: CCTP_TESTNET.finalityThreshold } }),
    data: encodeAbiParameters([
      { type: "uint256" }, { type: "bytes32" }, { type: "uint32" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "uint256" }, { type: "bytes" },
    ], [BigInt(2_000_000), mintRecipientBytes32(recipient.ata), CCTP_TESTNET.destinationDomain,
      ZERO_BYTES32, ZERO_BYTES32, BigInt(174_246), FORWARD_HOOK]),
  };
  const transfer = decodeSourceBurnReceipt({ status: "success", logs: [log] }, hash, recipient);
  assert.equal(transfer.sourceAddress, depositor);
  assert.equal(transfer.amountRaw, "2000000");
  assert.throws(() => decodeSourceBurnReceipt({ status: "success", logs: [log] }, hash,
    { ...recipient, ata: owner.toBase58() }), /Safe ATA/);
  assert.throws(() => decodeSourceBurnReceipt({ status: "success", logs: [{ ...log, address: from }] }, hash, recipient),
    /exactly one Circle burn/);
  assert.throws(() => decodeSourceBurnReceipt({ status: "success", logs: [log, log] }, hash, recipient),
    /exactly one Circle burn/);
});

test("journal deduplicates by source tx and rejects malformed records", () => {
  const map = new Map();
  const storage = { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  const transfer = { version: 1, sourceTxHash: hash, sourceAddress: from,
    owner: recipient.owner, safe: recipient.safe, ata: recipient.ata,
    amountRaw: "2000000", maxFeeRaw: "172765", startedAt: 1, stage: "source_pending" };
  saveJournal(storage, transfer);
  saveJournal(storage, { ...transfer, stage: "circle_pending" });
  assert.equal(readJournal(storage).length, 1);
  assert.equal(readJournal(storage)[0].stage, "circle_pending");
  map.set(CCTP_JOURNAL_KEY, JSON.stringify([{ ...transfer, sourceTxHash: "not-a-hash" }]));
  assert.equal(readJournal(storage).length, 0);
});

test("destination proof counts only the Safe ATA's minted USDC in the forward transaction", () => {
  const tx = { transaction: { message: { accountKeys: [{ pubkey: ata }, { pubkey: owner }] } },
    meta: { preTokenBalances: [{ accountIndex: 0, mint: CCTP_TESTNET.destinationUsdc.toBase58(), uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ accountIndex: 0, mint: CCTP_TESTNET.destinationUsdc.toBase58(), uiTokenAmount: { amount: "2827235" } }] } };
  assert.equal(mintedToAta(tx, ata.toBase58()), BigInt(1_827_235));
  assert.equal(mintedToAta(tx, owner.toBase58()), BigInt(0));
});
