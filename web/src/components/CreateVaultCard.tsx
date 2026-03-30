"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useVault } from "@/hooks/useVault";
import type { StrategyName } from "@/lib/vault";

const strategies: { name: StrategyName; description: string }[] = [
  { name: "Conservative", description: "60% USDC / 40% USDY" },
  { name: "Balanced", description: "30% USDC / 30% yield stables / 20% BTC / 20% equities" },
  { name: "Growth", description: "10% USDC / 20% sUSDe / 35% BTC / 35% equities" },
];

export function CreateVaultCard() {
  const { publicKey } = useWallet();
  const { vault, loading, txPending, error, createVault } = useVault();
  const [selected, setSelected] = useState<StrategyName>("Conservative");

  if (!publicKey) return null;
  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm text-muted-foreground">Checking vault status...</p>
      </div>
    );
  }
  if (vault) return null;

  const handleCreate = async () => {
    try {
      await createVault(selected);
    } catch {
      // error is shown via hook state
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-lg font-semibold mb-3">Create Yield AI Agent Safe</h2>
      <p className="text-sm text-muted-foreground mb-4">
        Create your personal AI-managed vault. Select a strategy:
      </p>

      <div className="space-y-2 mb-4">
        {strategies.map((s) => (
          <label
            key={s.name}
            className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
              selected === s.name
                ? "border-primary bg-primary/10"
                : "border-border hover:border-muted-foreground"
            }`}
          >
            <input
              type="radio"
              name="strategy"
              value={s.name}
              checked={selected === s.name}
              onChange={() => setSelected(s.name)}
              className="mt-0.5 accent-primary"
            />
            <div>
              <div className="text-sm font-medium">{s.name}</div>
              <div className="text-xs text-muted-foreground">{s.description}</div>
            </div>
          </label>
        ))}
      </div>

      {error && (
        <div className="text-sm text-destructive mb-3 p-2 bg-destructive/10 rounded">
          {error}
        </div>
      )}

      <button
        onClick={handleCreate}
        disabled={txPending}
        className="w-full py-2.5 px-4 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:bg-primary/90 transition-colors disabled:opacity-50"
      >
        {txPending ? "Creating..." : "Create Safe"}
      </button>
    </div>
  );
}
