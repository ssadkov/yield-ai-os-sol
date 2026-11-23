# Earn opportunity notes

Live source:
- `https://yieldai.app/api/protocols/kamino/borrowLend`
- `https://yieldai.app/api/protocols/kamino/pools`
- `https://yieldai.app/api/protocols/jupiter/pools`

The web app reads these through the local server route `/api/earn-ideas`, which fetches the external `yieldai.app` endpoints server-side and falls back to a curated snapshot if the external fetch fails. The first executable action is Kamino kVault USDC deposit from the vault PDA. Jupiter xStocks collateral deposit, borrow, repay, and collateral withdraw are also live as manual actions.

## Focus assets

Current focus groups:
- SOL assets: SOL, JitoSOL, mSOL, JupSOL, and other SOL LST collateral where liquidity is acceptable.
- BTC assets: cbBTC first, then WBTC/xBTC/LBTC/ZBTC/fBTC where markets are deep enough.
- xStocks: SPYx, QQQx, NVDAx, TSLAx, AAPLx, GOOGLx, MSTRx.
- RWA: ONyc/OnRe market is interesting even with a thinner spread because the risk source is different from crypto beta.

## USDC destination

Best USDC destination in the provided snapshot:

| Destination | Protocol | APY |
| --- | --- | ---: |
| Neutral Trade USDC Max Yield | Kamino vault | 8.39% |
| USDC Prime | Kamino vault | 7.45% |
| Kamino Private Credit USDC | Kamino vault | 7.23% |
| Jupiter USDC Earn | Jupiter | 4.25% |

For borrow-loop cards, the MVP compares the selected market's USDC borrow APY against the best USDC destination. The displayed spread is a borrow spread, not the whole-vault APY:

`borrow spread = USDC earn APY - USDC borrow APR`

Whole-vault APY is lower when only part of the collateral value is borrowed, because the spread is earned only on borrowed USDC while the equity base includes collateral value.

Off-chain risk logic still needs liquidation buffer, health factor, utilization, liquidity, oracle risk, and vault withdrawal liquidity.

## Candidate loops from the snapshot

| Focus | Collateral market | Borrow leg | Earn leg | Gross spread |
| --- | --- | --- | --- | ---: |
| xStocks | Jupiter SPYx / USDC | borrow USDC at about 0.41% | earn USDC at best USDC vault | highest current spread |
| xStocks | Jupiter QQQx / USDC, NVDAx / USDC, TSLAx / USDC | borrow USDC at about 2.41% | earn USDC at best USDC vault | medium current spread |
| xStocks | Kamino xStocks Market for AAPLx/GOOGLx/MSTRx | borrow USDC at about 4.8% | earn USDC at best USDC vault | thinner spread |
| BTC | Kamino Main Market or xStocks Market for cbBTC | borrow USDC at 5.04% or 4.76% | earn USDC at 8.39% | +3.35% to +3.64% |
| SOL | Kamino Main Market | borrow USDC at 5.04% | earn USDC at 8.39% | +3.35% |
| OnRe RWA | Kamino OnRe Market with ONyc | borrow USDC at 6.94% | earn USDC at 8.39% | +1.45% |

The loop cards are ideas. Execution remains manual in the Vault card: buy/hold collateral, deposit collateral to Jupiter Lend, borrow USDC, route USDC to earn, then repay and withdraw collateral when closing.

## Execution status

The sections that used to be here described the v1 program (`3Vtz…`, closed 2026-09-23): an
executor signing `execute_protocol_cpi` with SPL Token, Kamino and Jupiter Lend in the Safe
allowlist. That model is gone. In the current Safe (`yie1…`):

- money moves only through typed instructions: `kamino_deposit` / `kamino_withdraw`,
  `exponent_*`, and `orca_swap` / `orca_lp_*` (in source, not deployed yet);
- generic CPI is owner-only, can never target token or system programs, and adding a program
  takes a 48-hour timelock.

See [safe-cpi-policy-and-orca.md](safe-cpi-policy-and-orca.md). Jupiter Lend xStocks loops and
Kamino borrow loops need their own typed routes before they can be executed from a Safe.

## Vault value, APY, and PnL display

The Vault card separates receipt tokens from economic positions:
- `ki*` Kamino receipt tokens are hidden from normal holdings and displayed as Kamino Earn positions.
- Jupiter position NFTs / vault receipt tokens are hidden from normal holdings and displayed as Jupiter Lend positions.

Current total value is calculated as:

`visible holdings USD + Kamino underlying USD + Jupiter collateral USD - Jupiter debt USD`

Estimated annual yield is calculated as:

`direct holding yield + Kamino underlying * Kamino APY + Jupiter collateral * supply APY - Jupiter debt * borrow APR`

Estimated Vault APY is:

`estimated annual yield / current total value`

PnL uses the same current total value, so it includes funds sitting in Kamino and Jupiter positions rather than only loose token balances in the vault.

Next planned action:
- Package the manual borrow loop as a strategy with explicit liquidation, LTV, liquidity, and spread checks.
