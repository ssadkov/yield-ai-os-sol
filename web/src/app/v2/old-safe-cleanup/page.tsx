import { notFound } from "next/navigation";
import { V2OldSafeCleanup } from "@/components/V2OldSafeCleanup";

export default function V2OldSafeCleanupPage() {
  if (process.env.NEXT_PUBLIC_V2_LAB_ENABLED !== "1") notFound();
  return <V2OldSafeCleanup />;
}
