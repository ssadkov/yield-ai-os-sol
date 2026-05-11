import { Connection, PublicKey } from "@solana/web3.js";
import { getCurrentPosition } from "@jup-ag/lend/borrow";
import "dotenv/config";

const VAULT_PDA = new PublicKey("ArGScgEZcUXpuPjofSRRaFMQpTz6J1PWEYRLCiMmfnty");
const VAULT_ID = 78;
const POSITION_ID = 664;

const RPC = process.env.NEXT_PUBLIC_RPC_URL;
const conn = new Connection(RPC, "confirmed");

const pos = await getCurrentPosition({
  vaultId: VAULT_ID,
  positionId: POSITION_ID,
  connection: conn,
});

console.log("Raw position state from chain:");
console.log("  colRaw       :", pos.colRaw.toString());
console.log("  debtRaw      :", pos.debtRaw.toString());
console.log("  dustDebtRaw  :", pos.dustDebtRaw.toString());
console.log("  finalAmount  :", pos.finalAmount.toString());
console.log("  isSupplyOnly :", pos.isSupplyOnlyPosition);
console.log("  tick         :", pos.tick);
console.log();

const debtRaw = BigInt(pos.debtRaw.toString());
const dust = BigInt(pos.dustDebtRaw.toString());
const netDebt = debtRaw > dust ? debtRaw - dust : 0n;
console.log("Computed:");
console.log("  netDebt (scaled)   :", netDebt.toString());
console.log("  netDebt / 1000     :", (netDebt / 1000n).toString(), "user units");
console.log("  netDebt / 1000 USD :", "$" + (Number(netDebt / 1000n) / 1e6).toFixed(6));
console.log("  -100 safety user   :", (netDebt / 1000n - 100n).toString());
