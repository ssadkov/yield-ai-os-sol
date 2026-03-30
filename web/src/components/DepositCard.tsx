"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useVault } from "@/hooks/useVault";

export function DepositCard() {
  const { publicKey } = useWallet();
  const { vault, txPending, error, deposit } = useVault();
  const [amount, setAmount] = useState("");

  if (!publicKey || !vault) return null;

  const handleDeposit = async () => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) return;
    try {
      await deposit(val);
      setAmount("");
    } catch {
      // error shown via hook
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="text-lg font-semibold mb-3">Deposit USDC</h2>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="w-full py-2 px-3 pr-16 rounded-md bg-accent border border-border text-sm font-mono focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-medium">
            USDC
          </span>
        </div>
        <button
          onClick={handleDeposit}
          disabled={txPending || !amount || parseFloat(amount) <= 0}
          className="py-2 px-4 rounded-md bg-success text-white font-medium text-sm hover:bg-success/90 transition-colors disabled:opacity-50"
        >
          {txPending ? "..." : "Deposit"}
        </button>
      </div>

      {error && (
        <div className="text-sm text-destructive mt-2 p-2 bg-destructive/10 rounded">
          {error}
        </div>
      )}
    </div>
  );
}
