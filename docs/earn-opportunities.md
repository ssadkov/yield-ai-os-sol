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

## Jupiter Lend collateral execution

Status: launched in the UI for xStocks / USDC collateral positions.

What is live:
- Deposit xStocks collateral from the vault into Jupiter Lend borrow positions.
- Borrow USDC manually from an existing Jupiter Lend position into the vault.
- Repay USDC manually from the vault into an existing Jupiter Lend position.
- Reuse an existing Jupiter position NFT held by the vault PDA.
- Create a position NFT only when none exists, then transfer it into the vault PDA.
- Withdraw all Jupiter collateral back to the vault when debt is zero.
- Show Jupiter Lend positions inside the Vault card with collateral, debt, USD value, APY/APR, net APY, market, and position id.

Current enabled collateral markets:
- `TSLAx / USDC` - Jupiter borrow vault `77`.
- `SPYx / USDC` - Jupiter borrow vault `78`.
- `QQQx / USDC` - Jupiter borrow vault `79`.
- `NVDAx / USDC` - Jupiter borrow vault `80`.

Execution model:
- The executor signs the outer transaction with `AUTHORITY_SECRET_KEY`.
- The vault program wraps Jupiter Borrow `Operate` through `execute_protocol_cpi`.
- The vault PDA signs the inner Jupiter instructions with `invoke_signed`.
- Initial position NFT creation is paid by the executor because a program-owned vault PDA cannot pay System Program rent directly.

Known behavior:
- Jupiter Borrow position accounting uses 9-decimal internal precision even when the collateral token has 8 decimals.
- The UI displays user-friendly token units from this accounting value.
- MAX collateral deposits leave one raw token unit in the vault to avoid Token-2022 transfer rounding failures.
- Withdraw is currently all-collateral only and disabled while the position has debt.
- Borrow is currently a manual USDC amount input. The protocol simulation enforces borrow limits and health factor; product-level risk limits are not automated yet.
- Repay is currently a manual USDC amount input. The source of repayment is USDC already inside the vault. If borrowed USDC was deposited into Kamino Earn, withdraw from Kamino back to the vault first, then repay.

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
