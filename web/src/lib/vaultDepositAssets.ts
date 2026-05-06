import { USDC_MINT_STR } from "@/lib/constants";

export interface VaultDepositAsset {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  group: "Stable" | "BTC" | "xStocks";
}

export const VAULT_DEPOSIT_ASSETS: VaultDepositAsset[] = [
  {
    symbol: "USDC",
    name: "USD Coin",
    mint: USDC_MINT_STR,
    decimals: 6,
    group: "Stable",
  },
  {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    decimals: 8,
    group: "BTC",
  },
  {
    symbol: "xBTC",
    name: "OKX Wrapped BTC",
    mint: "CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn",
    decimals: 8,
    group: "BTC",
  },
  {
    symbol: "SPYx",
    name: "SP500 xStock",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    decimals: 8,
    group: "xStocks",
  },
  {
    symbol: "QQQx",
    name: "Nasdaq 100 xStock",
    mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    decimals: 8,
    group: "xStocks",
  },
  {
    symbol: "NVDAx",
    name: "NVIDIA xStock",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    decimals: 8,
    group: "xStocks",
  },
  {
    symbol: "TSLAx",
    name: "Tesla xStock",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    decimals: 8,
    group: "xStocks",
  },
  {
    symbol: "AAPLx",
    name: "Apple xStock",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    decimals: 8,
    group: "xStocks",
  },
  {
    symbol: "GOOGLx",
    name: "Alphabet xStock",
    mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    decimals: 8,
    group: "xStocks",
  },
  {
    symbol: "MSTRx",
    name: "MicroStrategy xStock",
    mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    decimals: 8,
    group: "xStocks",
  },
];
