/** Read-only Kamino SDK withdrawal planner for the fixed Yield AI v2 pilot Safe. */
import { address, createDefaultRpcTransport, createNoopSigner, createSolanaRpcFromTransport } from "@solana/kit";
import { KaminoManager, KaminoVault, getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";

const SAFE = "FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ";
const KVAULT = "91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy";
const KVAULT_PROGRAM = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARES_MINT = "B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe";
const WITHDRAW = "b712469c946da122";
const WITHDRAW_AVAILABLE = "1383709baadc2239";

async function main() {
  if (process.argv.slice(2).length) throw new Error("No arguments accepted");
  const endpoint = process.env.V2_MAINNET_RPC_URL;
  const sharesRaw = process.env.V2_PILOT_SHARES_RAW;
  if (!endpoint || !/^[1-9]\d*$/.test(sharesRaw ?? "")) throw new Error("Set RPC and exact on-chain shares amount");
  const rpc = createSolanaRpcFromTransport(createDefaultRpcTransport({ url: endpoint }));
  const vault = new KaminoVault(rpc, address(KVAULT), 400);
  const state = await vault.getState();
  if (state.tokenMint !== USDC || state.sharesMint !== SHARES_MINT) throw new Error("Unexpected Kamino vault mints");
  const reserves = await new KaminoManager(rpc, 400).loadVaultReserves(state);
  const amount = new Decimal(sharesRaw).div(new Decimal(10).pow(state.sharesMintDecimals.toNumber()));
  const bundle = await vault.withdrawIxs(createNoopSigner(address(SAFE)), amount,
    await getCurrentLedgerInstant(rpc), reserves, null, null);
  if (bundle.unstakeFromFarmIfNeededIxs.length) throw new Error("Farm-staked shares are unsupported");
  const withdrawals = bundle.withdrawIxs.filter((ix) => ix.programAddress === KVAULT_PROGRAM).map((ix) => {
    if (!ix.data || ix.data.length !== 16) throw new Error("Unexpected Kamino withdrawal data");
    const data = Buffer.from(ix.data);
    const discriminator = data.subarray(0, 8).toString("hex");
    if ((discriminator !== WITHDRAW && discriminator !== WITHDRAW_AVAILABLE) ||
        ix.accounts?.[0]?.address !== SAFE || ix.accounts?.[1]?.address !== KVAULT) {
      throw new Error("Unexpected Kamino withdrawal instruction");
    }
    return { discriminator, shares: data.readBigUInt64LE(8).toString(),
      accounts: ix.accounts.map((a) => ({ address: a.address, writable: (a.role & 1) !== 0 })) };
  });
  if (!withdrawals.length) throw new Error("No withdrawal instructions");
  console.log(JSON.stringify({ safe: SAFE, sourceSharesRaw: sharesRaw, withdrawals,
    lookupTables: state.vaultLookupTable === "11111111111111111111111111111111" ? [] : [state.vaultLookupTable] }));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
