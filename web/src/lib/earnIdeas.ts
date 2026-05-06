import { SOL_MINT, USDC_MINT_STR } from "@/lib/constants";

export interface EarnIdea {
  id: string;
  title: string;
  protocol: string;
  focus: "USDC" | "SOL" | "BTC" | "xStocks" | "RWA";
  description: string;
  apyLabel: string;
  spreadLabel?: string;
  borrowLabel?: string;
  requiredMints: string[];
  note: string;
  action?: {
    type: "kaminoKvaultDeposit";
    kvault: string;
    tokenMint: string;
    tokenDecimals: number;
  };
}

export const EARN_IDEAS: EarnIdea[] = [
  {
    id: "usdc-kamino-neutral",
    title: "Best USDC earn",
    protocol: "Kamino",
    focus: "USDC",
    description: "Deposit USDC into Neutral Trade USDC Max Yield.",
    apyLabel: "8.39% APY",
    requiredMints: [USDC_MINT_STR],
    note: "Highest USDC-only destination in the current snapshot.",
    action: {
      type: "kaminoKvaultDeposit",
      kvault: "67dqmR76uAbjX6e81A1ganKv3ou31WUMEdeWJkwVfeXy",
      tokenMint: USDC_MINT_STR,
      tokenDecimals: 6,
    },
  },
  {
    id: "xstocks-usdc-loop",
    title: "xStocks collateral loop",
    protocol: "Kamino",
    focus: "xStocks",
    description: "Use xStocks collateral, borrow USDC, then route USDC to the best earn vault.",
    apyLabel: "8.39% earn",
    borrowLabel: "4.76% USDC borrow",
    spreadLabel: "+3.64% gross spread",
    requiredMints: [
      "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", // SPYx
      "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", // QQQx
      "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", // NVDAx
      "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", // TSLAx
      "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp", // AAPLx
      "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN", // GOOGLx
      "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ", // MSTRx
    ],
    note: "Direct Token-2022 deposit/withdraw still needs token-interface support.",
  },
  {
    id: "btc-usdc-loop",
    title: "BTC collateral loop",
    protocol: "Kamino",
    focus: "BTC",
    description: "Use cbBTC or other BTC collateral, borrow USDC, then route USDC to the best earn vault.",
    apyLabel: "8.39% earn",
    borrowLabel: "4.76% to 5.04% USDC borrow",
    spreadLabel: "+3.35% to +3.64% gross spread",
    requiredMints: [
      "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij", // cbBTC
      "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // WBTC
      "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn", // xBTC
      "LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY", // LBTC
      "zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg", // ZBTC
      "3orqhCKM5admbcHkHQhRAEKbXhUT5VPgsQqz7fBa6QdF", // fBTC
    ],
    note: "cbBTC is the first target because it is already in the strategy token set.",
  },
  {
    id: "sol-usdc-loop",
    title: "SOL collateral loop",
    protocol: "Kamino",
    focus: "SOL",
    description: "Use SOL or liquid staking SOL collateral, borrow USDC, then route USDC to the best earn vault.",
    apyLabel: "8.39% earn",
    borrowLabel: "5.04% USDC borrow",
    spreadLabel: "+3.35% gross spread",
    requiredMints: [
      SOL_MINT,
      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", // JitoSOL
      "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", // mSOL
      "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v", // JupSOL
      "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", // bSOL
    ],
    note: "Keep a conservative borrow buffer; SOL collateral volatility dominates this loop.",
  },
  {
    id: "onre-rwa-loop",
    title: "OnRe RWA loop",
    protocol: "Kamino",
    focus: "RWA",
    description: "Use ONyc collateral in the OnRe market, borrow USDC, then route USDC to the best earn vault.",
    apyLabel: "8.39% earn",
    borrowLabel: "6.94% USDC borrow",
    spreadLabel: "+1.45% gross spread",
    requiredMints: [
      "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5", // ONyc
    ],
    note: "Interesting RWA risk source, but spread is thinner than BTC/xStocks/SOL loops.",
  },
];

export const EARN_IDEA_SYMBOLS: Record<string, string> = {
  [USDC_MINT_STR]: "USDC",
  [SOL_MINT]: "SOL",
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: "cbBTC",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC",
  CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn: "xBTC",
  LBTCgU4b3wsFKsPwBn1rRZDx5DoFutM6RPiEt1TPDsY: "LBTC",
  zBTCug3er3tLyffELcvDNrKkCymbPWysGcWihESYfLg: "ZBTC",
  "3orqhCKM5admbcHkHQhRAEKbXhUT5VPgsQqz7fBa6QdF": "fBTC",
  XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W: "SPYx",
  Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ: "QQQx",
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: "NVDAx",
  XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB: "TSLAx",
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: "AAPLx",
  XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN: "GOOGLx",
  XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ: "MSTRx",
  "5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5": "ONyc",
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: "JitoSOL",
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: "mSOL",
  jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v: "JupSOL",
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: "bSOL",
};
