import { checkedMobileTransaction, type MobileAction, type MobilePlan } from "./mobileSafeWallet.ts";
import { MOBILE_NETWORKS } from "./mobileNetworks.ts";
import { PublicKey } from "@solana/web3.js";
export const DEVNET_GENESIS = MOBILE_NETWORKS.devnet.genesis;
export type DevnetAction = MobileAction;
export type DevnetPlan = MobilePlan;
export const checkedDevnetTransaction = (plan: MobilePlan, owner: PublicKey, action: MobileAction, requested: string) => checkedMobileTransaction(plan, owner, action, requested, "devnet");
