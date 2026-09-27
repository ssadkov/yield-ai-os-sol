import { notFound } from "next/navigation";
import { V2CctpProbe } from "@/components/V2CctpProbe";

export default function V2CctpPage() {
  if (process.env.NEXT_PUBLIC_V2_CCTP_ENABLED !== "1") notFound();
  return <V2CctpProbe />;
}
