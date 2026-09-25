import { notFound } from "next/navigation";
import { V2MainnetMemoProbe } from "@/components/V2MainnetMemoProbe";

export default function V2MainnetProbePage() {
  if (process.env.NEXT_PUBLIC_V2_LAB_ENABLED !== "1") notFound();
  return <V2MainnetMemoProbe />;
}
