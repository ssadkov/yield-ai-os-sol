import type { AddressLookupTableAccount, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { LendingProtocolAction } from "./actions";

export type ProtocolActionBuild = {
  protocol: "jupiterBorrow" | "kamino";
  action: LendingProtocolAction;
  setupIxs: TransactionInstruction[];
  cpiIxs: TransactionInstruction[];
  cleanupIxs: TransactionInstruction[];
  alts: AddressLookupTableAccount[];
  requiredPrograms: PublicKey[];
};
