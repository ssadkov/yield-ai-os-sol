import { notFound } from "next/navigation";
import { V2CctpProbe } from "@/components/V2CctpProbe";

export default function V2CctpMainnetPage() {
  if (process.env.NEXT_PUBLIC_V2_CCTP_MAINNET_ENABLED !== "1") notFound();
  return <V2CctpProbe routeMode="mainnet" />;
}
