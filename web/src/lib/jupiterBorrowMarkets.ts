export type JupiterBorrowCollateralMarket = {
  symbol: string;
  mint: string;
  decimals: number;
  vaultId: number;
  borrowSymbol: "USDC" | "JupUSD";
  borrowMint: string;
};

export const JUPITER_XSTOCKS_USDC_MARKETS: JupiterBorrowCollateralMarket[] = [
  {
    symbol: "TSLAx",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    decimals: 8,
    vaultId: 77,
    borrowSymbol: "USDC",
    borrowMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  {
    symbol: "SPYx",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    decimals: 8,
    vaultId: 78,
    borrowSymbol: "USDC",
    borrowMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  {
    symbol: "QQQx",
    mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    decimals: 8,
    vaultId: 79,
    borrowSymbol: "USDC",
    borrowMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
  {
    symbol: "NVDAx",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    decimals: 8,
    vaultId: 80,
    borrowSymbol: "USDC",
    borrowMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  },
];
