import { PublicKey } from "@solana/web3.js";
import { address, createDefaultRpcTransport, createNoopSigner, createSolanaRpcFromTransport } from "@solana/kit";
import { KaminoManager, KaminoVault, getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { V2_MAINNET_RPC_URL, v2MainnetRpcHeaders } from "@/lib/v2MainnetRpc.server";

const KVAULT_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const USDC_KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARES_MINT = "B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe";
const WITHDRAW = "b712469c946da122";
const WITHDRAW_AVAILABLE = "1383709baadc2239";
export async function kaminoWithdrawalAccounts(safe: PublicKey, shares: bigint) {
  const rpc = createSolanaRpcFromTransport(createDefaultRpcTransport({
    url: V2_MAINNET_RPC_URL,
    headers: v2MainnetRpcHeaders(),
  }));
  const vault = new KaminoVault(rpc, address(USDC_KVAULT), 400);
  const state = await vault.getState();
  if (state.tokenMint !== USDC_MINT || state.sharesMint !== SHARES_MINT) throw new Error("unexpected vault mints");
  const reserves = await new KaminoManager(rpc, 400).loadVaultReserves(state);
  const amount = new Decimal(shares.toString()).div(new Decimal(10).pow(state.sharesMintDecimals.toNumber()));
  const bundle = await vault.withdrawIxs(
    createNoopSigner(address(safe.toBase58())), amount, await getCurrentLedgerInstant(rpc), reserves,
    null, null,
  );
  // The Safe keeps shares in its ATA; it never stakes them in a Kamino farm.
  if (bundle.unstakeFromFarmIfNeededIxs.length) throw new Error("staked shares are unsupported");
  const safeUsdc = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), safe, true).toBase58();
  const safeShares = getAssociatedTokenAddressSync(new PublicKey(SHARES_MINT), safe, true).toBase58();
  const withdrawals = bundle.withdrawIxs
    .filter((ix) => ix.programAddress === KVAULT_PROGRAM)
    .map((ix) => {
      if (!ix.data) throw new Error("missing Kamino withdrawal data");
      const data = Buffer.from(ix.data);
      const discriminator = data.subarray(0, 8).toString("hex");
      if (data.length !== 16 || (discriminator !== WITHDRAW && discriminator !== WITHDRAW_AVAILABLE)
        || ix.accounts?.[0]?.address !== safe.toBase58() || ix.accounts?.[1]?.address !== USDC_KVAULT
        || ix.accounts?.[5]?.address !== safeUsdc || ix.accounts?.[7]?.address !== safeShares) {
        throw new Error("unexpected Kamino withdrawal layout");
      }
      return {
        shares: data.readBigUInt64LE(8).toString(), discriminator,
        accounts: ix.accounts.map((a) => ({ address: a.address, writable: (a.role & 1) !== 0 })),
      };
    });
  if (!withdrawals.length) throw new Error("no Kamino withdrawal instructions");
  const lookupTable = state.vaultLookupTable;
  return { safe: safe.toBase58(), withdrawals,
    lookupTables: lookupTable === PublicKey.default.toBase58() ? [] : [lookupTable] };
}
