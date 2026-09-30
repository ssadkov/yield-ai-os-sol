// Read-only SDK layout probe. It does not simulate a funded exit, sign or send.
import { PublicKey } from "@solana/web3.js";
import { address, createDefaultRpcTransport, createNoopSigner, createSolanaRpcFromTransport } from "@solana/kit";
import { KaminoManager, KaminoVault, getCurrentLedgerInstant } from "@kamino-finance/klend-sdk";
import Decimal from "decimal.js";
import { MOBILE_KAMINO, MOBILE_NETWORKS, safeAddresses, checkedKaminoWithdrawal } from "../src/lib/mobileSafe.ts";
try {
  const endpoint = process.env.V2_MAINNET_RPC_URL;
  if (!endpoint) throw new Error();
  const rpc = createSolanaRpcFromTransport(createDefaultRpcTransport({ url:endpoint }));
  const owner = new PublicKey(process.env.MOBILE_PROBE_OWNER ?? "EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2");
  const safe = safeAddresses(owner,MOBILE_NETWORKS.mainnet).safe;
  const shares = BigInt(process.env.MOBILE_PROBE_SHARES ?? "1000000");
  const vault = new KaminoVault(rpc,address(MOBILE_KAMINO.vault),400);
  const state = await vault.getState();
  const reserves = await new KaminoManager(rpc,400).loadVaultReserves(state);
  const bundle = await vault.withdrawIxs(createNoopSigner(address(String(safe))),new Decimal(String(shares)).div(new Decimal(10).pow(state.sharesMintDecimals.toNumber())),await getCurrentLedgerInstant(rpc),reserves,null,null);
  if(bundle.unstakeFromFarmIfNeededIxs.length) throw new Error();
  const withdrawals = bundle.withdrawIxs.filter(ix=>ix.programAddress===MOBILE_KAMINO.program).map(ix=>({shares:Buffer.from(ix.data).readBigUInt64LE(8).toString(),discriminator:Buffer.from(ix.data).subarray(0,8).toString("hex"),accounts:ix.accounts.map(a=>({address:a.address,writable:(a.role&1)!==0}))}));
  const plan=checkedKaminoWithdrawal({safe:String(safe),withdrawals,lookupTables:state.vaultLookupTable===String(PublicKey.default)?[]:[state.vaultLookupTable]},safe,owner,shares);
  console.log(JSON.stringify({safe:String(safe),requestedSharesRaw:String(shares),firstLegSharesRaw:String(plan.shares),fromReserve:plan.fromReserve,accountCount:plan.accounts.length,sdkLegCount:withdrawals.length,lookupTableCount:plan.lookupTables.length,verification:"current SDK account layout only; no funded withdrawal sent"}));
}catch(err){console.error(JSON.stringify({code:err.code??"SDK_PROBE_FAILED",message:err.code?err.message:"Read-only SDK probe failed; private endpoint omitted"}));process.exitCode=1;}
