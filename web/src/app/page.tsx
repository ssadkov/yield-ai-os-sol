"use client";

import { Header } from "@/components/Header";
import { WalletAssetsCard } from "@/components/WalletAssetsCard";
import { CreateVaultCard } from "@/components/CreateVaultCard";
import { DepositCard } from "@/components/DepositCard";
import { VaultCard } from "@/components/VaultCard";
import { AIChat } from "@/components/AIChat";

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 p-4 lg:p-6 min-h-0">
        <div className="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch min-h-0">
          {/* Left column — wallet */}
          <div className="space-y-6 min-h-0">
            <WalletAssetsCard />
            <CreateVaultCard />
          </div>

          {/* Center column — vault operations */}
          <div className="space-y-6 min-h-0">
            <DepositCard />
            <VaultCard />
          </div>

          {/* Right column — chat */}
          <div className="h-full min-h-0">
            <AIChat />
          </div>
        </div>
      </main>
    </div>
  );
}
