# Strategy token icons

Icons for `ALL_TOKENS` in `src/server/agent/rebalance/tokens.ts` are downloaded with:

```bash
cd web
node scripts/fetch-strategy-token-icons.mjs
```

Files are written to `public/token-catalog/strat_<SYMBOL>_<mint-prefix>.*` and listed in `strategy-token-icons.json`.

## USDY (manual fallback)

Jupiter/Helius metadata points to an Arweave URL that often returns **404**. The script then tries a **CoinGecko** image URL; if your network blocks it, save the icon manually as:

`public/token-catalog/strat_USDY_A1KLoBrK.png`

Suggested source (Ondo / USDY on CoinGecko):

`https://coin-images.coingecko.com/coins/images/31700/large/usdy_%281%29.png?1696530524`
