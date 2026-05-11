"use client";

import dynamic from "next/dynamic";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

export function Header() {
  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center px-6 py-4 border-b border-border gap-4">
      <div className="flex items-center gap-2">
        <span className="text-xl font-bold tracking-tight">Yield AI agent SOL</span>
      </div>
      <div className="hidden md:flex items-center justify-center text-sm text-muted-foreground">
        <span>
          <span className="text-foreground font-semibold">Put your capital to work.</span>{" "}
          <span className="opacity-80">Your keys stay yours.</span>
        </span>
      </div>
      <div className="flex justify-end">
        <WalletMultiButton />
      </div>
    </header>
  );
}
