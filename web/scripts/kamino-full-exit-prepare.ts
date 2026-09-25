// Expand the existing local fork fixture with every account needed by Kamino invest/full withdraw.
// Reads public mainnet state and writes only account-address lists; it never signs or sends.
import { readFileSync, writeFileSync } from "node:fs";
import { createNoopSigner, createSolanaRpc, address } from "@solana/kit";
import { KaminoManager, KaminoVault, getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import { PublicKey } from "@solana/web3.js";
import { AccountLayout, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import Decimal from "decimal.js";

const dir = process.env.KFORK_DIR ?? "/tmp/kfork";
const KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const KVAULT_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const KLEND_PROGRAM = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const rpc = createSolanaRpc(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com");

async function main() {
  const previous = JSON.parse(readFileSync(`${dir}/kamino.json`, "utf8"));
  const safe = new PublicKey(previous.deposit.find((ix: { programAddress: string }) => ix.programAddress === KVAULT_PROGRAM).accounts[0].address);
  const accountFile = JSON.parse(readFileSync(`${dir}/owner-usdc.json`, "utf8"));
  const owner = new PublicKey(AccountLayout.decode(Buffer.from(accountFile.account.data[0], "base64")).owner);
  const signer = createNoopSigner(address(owner.toBase58()));
  const vault = new KaminoVault(rpc, address(KVAULT), 400);
  const state = await vault.getState();
  const reserves = await new KaminoManager(rpc, 400).loadVaultReserves(state);
  const tokenMint = new PublicKey(state.tokenMint);
  const sharesMint = new PublicKey(state.sharesMint);
  const ownerUsdc = getAssociatedTokenAddressSync(tokenMint, owner);
  const safeUsdc = getAssociatedTokenAddressSync(tokenMint, safe, true);
  const safeShares = getAssociatedTokenAddressSync(sharesMint, safe, true);
  const skip = new Set([
    owner.toBase58(), safe.toBase58(), ownerUsdc.toBase58(), safeUsdc.toBase58(), safeShares.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(), "11111111111111111111111111111111",
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", "Sysvar1nstructions1111111111111111111111111",
  ]);
  const programs = new Set(readFileSync(`${dir}/clone-programs.txt`, "utf8").trim().split(/\s+/));
  programs.add(KVAULT_PROGRAM);
  programs.add(KLEND_PROGRAM);
  const accounts = new Set(readFileSync(`${dir}/clone-accounts.txt`, "utf8").trim().split(/\s+/));
  for (const [, reserve] of reserves) {
    const info = reserve.state.config.tokenInfo;
    for (const oracle of [info.pythConfiguration.price, info.switchboardConfiguration.priceAggregator,
      info.switchboardConfiguration.twapAggregator, info.scopeConfiguration.priceFeed]) {
      if (oracle !== PublicKey.default.toBase58()) accounts.add(oracle);
    }
  }
  const addIx = (ix: { accounts?: readonly { address: string }[] }) => {
    for (const meta of ix.accounts ?? []) if (!skip.has(meta.address) && !programs.has(meta.address)) accounts.add(meta.address);
  };
  const first = [...reserves][0];
  if (!first) throw new Error("Vault has no active reserve");
  const [reserveAddress, reserve] = first;
  const investIx = await (vault.client as any).buildInvestSingleReserveIx({
    payer: signer, vault, reserve: { address: reserveAddress, state: reserve.state }, vaultState: state,
    vaultReservesMap: reserves, tokenProgram: address(TOKEN_PROGRAM_ID.toBase58()),
    payerTokenAta: address(ownerUsdc.toBase58()), maxAmountLamports: new Decimal(60_000_000),
  });
  addIx(investIx);
  for (const [reserveKey, reserveState] of reserves) {
    addIx(await (vault.client as any).withdrawIx(
      createNoopSigner(address(safe.toBase58())), vault, state, reserveState.state.lendingMarket,
      { address: reserveKey, state: reserveState.state }, address(safeShares.toBase58()),
      address(safeUsdc.toBase58()), new Decimal(60_000_000), reserves,
    ));
  }
  if (state.vaultLookupTable !== PublicKey.default.toBase58()) accounts.add(state.vaultLookupTable);
  const slot = Number(await rpc.getSlot().send());
  writeFileSync(`${dir}/clone-programs.txt`, [...programs].sort().join("\n") + "\n");
  writeFileSync(`${dir}/clone-accounts.txt`, [...accounts].filter(Boolean).sort().join("\n") + "\n");
  writeFileSync(`${dir}/fork-slot.txt`, `${slot + 10}\n`);
  console.log(`Safe ${safe}, reserves ${reserves.size}, programs ${programs.size}, accounts ${accounts.size}, warp slot ${slot + 10}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
