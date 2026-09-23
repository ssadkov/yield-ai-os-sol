import { notFound } from "next/navigation";
import { V2WalletLab } from "@/components/V2WalletLab";

export default function V2LabPage() {
  const rpc = process.env.NEXT_PUBLIC_RPC_URL ?? "";
  if (process.env.NEXT_PUBLIC_V2_LAB_ENABLED !== "1" || !rpc.includes("devnet")) notFound();
  return <V2WalletLab />;
}
