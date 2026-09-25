import { notFound } from "next/navigation";
import { V2CctpProbe } from "@/components/V2CctpProbe";

export default function V2CctpPage() {
  const rpc = process.env.NEXT_PUBLIC_RPC_URL ?? "";
  if (process.env.NEXT_PUBLIC_V2_LAB_ENABLED !== "1" || !rpc.includes("devnet")) notFound();
  return <V2CctpProbe />;
}
