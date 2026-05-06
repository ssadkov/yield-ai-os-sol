# Earn opportunity notes

Live source:
- `https://yieldai.app/api/protocols/kamino/borrowLend`
- `https://yieldai.app/api/protocols/kamino/pools`
- `https://yieldai.app/api/protocols/jupiter/pools`

The web app reads these through the local server route `/api/earn-ideas`, which fetches the external `yieldai.app` endpoints server-side and falls back to a curated snapshot if the external fetch fails. The first executable action is Kamino kVault USDC deposit from the vault PDA; borrow loops are still displayed as ideas until position accounting and risk checks are wired.

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

For borrow-loop cards, the MVP compares the selected market's USDC borrow APY against the best USDC destination. Gross spread is only a first filter. Off-chain risk logic still needs liquidation buffer, health factor, utilization, liquidity, oracle risk, and vault withdrawal liquidity.

## Candidate loops from the snapshot

| Focus | Collateral market | Borrow leg | Earn leg | Gross spread |
| --- | --- | --- | --- | ---: |
| xStocks | Kamino xStocks Market | borrow USDC at 4.76% | earn USDC at 8.39% | +3.64% |
| BTC | Kamino Main Market or xStocks Market for cbBTC | borrow USDC at 5.04% or 4.76% | earn USDC at 8.39% | +3.35% to +3.64% |
| SOL | Kamino Main Market | borrow USDC at 5.04% | earn USDC at 8.39% | +3.35% |
| OnRe RWA | Kamino OnRe Market with ONyc | borrow USDC at 6.94% | earn USDC at 8.39% | +1.45% |

The loop cards intentionally show these as ideas, not executable actions.

## Contract capability check

The current on-chain program is not hardcoded to the USDC mint, despite the account names `usdc_mint`, `owner_usdc_ata`, and `vault_usdc_ata`.

What works technically:
- `deposit` can transfer any classic SPL Token mint if the caller supplies:
  - the mint account,
  - the owner's token account for that mint,
  - the vault PDA associated token account for that mint.
- `withdraw` has the same mint-flexible constraints even though it is named USDC in code.
- `withdraw_spl` is explicitly generic for any vault-owned classic SPL Token account with `token::authority = vault`.
- `execute_protocol_cpi` can call whitelisted lending protocols and lets the vault PDA sign via seeds.

Current blockers:
- The web helpers `depositUsdc` and `withdrawUsdc` hardcode `USDC_MINT`.
- The deposit path does not create the vault ATA for arbitrary mints. The ATA must exist before `deposit` is called.
- Direct deposit/withdraw instructions use `anchor_spl::token::{Token, TokenAccount}` and therefore target the classic SPL Token Program. Token-2022 assets need a separate `token_interface` or Token-2022 compatible instruction path.
- Existing PnL/history code assumes USDC decimals and USDC-only deposits/withdrawals.

Conclusion:
- Classic SPL deposits/withdrawals are not fundamentally blocked by the contract, but the web surface is currently USDC-only.
- Token-2022 direct deposits/withdrawals are effectively blocked until we add token-interface support.
- Protocol CPI actions are the right path for Kamino/Jupiter positions, but position accounting and liquidation checks stay off-chain for MVP.

## Kamino kVault execution

Kamino Earn deposits are built server-side through `POST /ktx/kvault/deposit-instructions`.

Execution model:
- `wallet` in the Kamino request is the vault PDA.
- The backend executor signs the outer transaction with `AUTHORITY_SECRET_KEY`.
- The vault program wraps Kamino kVault and farm instructions through `execute_protocol_cpi`.
- The vault PDA signs inner Kamino instructions with `invoke_signed`.
- ATA setup is sent directly with the backend executor as payer, because the vault PDA is program-owned and cannot pay System Program rent.

Required allowlist entries:
- `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd` - Kamino kVault.
- `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr` - Kamino Farms.
- `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` - Kamino Lend, included for upcoming direct borrow/lend actions.
