# Yield AI — USDC savings, flexible or fixed

Deposit USDC from a phone, choose **flexible** or **fixed**, and keep custody. Funds sit in a
personal **Safe** on Solana that only the owner can withdraw from. An agent can act on the Safe
only through typed instructions and within limits the owner sets.

[Mobile app (Android / Seeker)](https://github.com/ssadkov/yield-ai-mobile) ·
[Program on Solscan](https://solscan.io/account/yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih) ·
[Mainnet API config](https://yield-ai-solana-mainnet.vercel.app/api/mobile/v1/config) ·
[Owner protocol API](docs/yield-ai-v2-owner-protocol-api.md) ·
[X](https://x.com/yieldai_app)

| | |
|---|---|
| Program (mainnet) | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` |
| Flexible | USDC supplied to the Kamino USDC kVault. Variable APY, withdraw any time. |
| Fixed | USDC converted into an Exponent principal token (PT) maturing 2027-01-10. Rate locked at entry; exit before maturity sells at the market price. |
| Clients | Native Android app for Solana Mobile ([repo](https://github.com/ssadkov/yield-ai-mobile)); Next.js web app and unsigned-transaction API in [`web/`](web/) |

## Why we built it

We already run [Yield AI on Aptos](https://defillama.com/protocol/yield-ai): **$540k TVL on
DefiLlama as of 2026-10-09**, from real depositors. Talking to them showed three things:

- People understand stablecoins. Choosing between four AI-built strategies was too much, so the
  product is now two plans: flexible or fixed.
- Many of them bridge in from EVM chains. Entering a new chain is the main barrier, so the next
  step is USDC in from other chains (see [Roadmap](#roadmap)).
- "Where does the yield come from?" is the most common question. Every position and transaction
  is visible on-chain and linked from the app.

Solana has the liquidity and the protocols to compose these products (Kamino, Exponent, Orca,
Jupiter). The Safe program below is the Solana version, built during the Crypto World's Fair
hackathon.

## What the program guarantees

The Solana program (`programs/yield-vault`, Anchor 0.32.1) holds each user's funds in a Safe PDA
derived from the owner's wallet (`["vault", owner]`).

- **Only the owner withdraws.** Every instruction that moves tokens or SOL out to an arbitrary
  destination requires the owner's signature. Owner withdrawal works with no executor running.
- **The agent has no generic access.** `execute_swap_cpi` and `execute_protocol_cpi` are
  owner-only, and they cannot touch Kamino kVault shares or Exponent position tokens. An approved
  executor can call only typed instructions: `kamino_deposit` / `kamino_withdraw` and Exponent
  `buy` / `sell` / `redeem`.
- **Executors are allowlisted and limited.** A global executor registry (max 16, admin-managed)
  plus per-Safe limits set by the owner: allowed actions, rolling 24-hour USDC volume, principal.
  No executor can move USDC until the owner enables limits for that Safe.
- **Fixed-income guardrails.** Each Exponent position stores a maximum loss and maximum slippage;
  exits that breach them fail. Exit proceeds go straight to the owner's USDC account.
- **Fees are capped in code.** A performance fee applies only to realized profit, hard-capped at
  20% (`MAX_PERFORMANCE_FEE_BPS`). The Exponent pilot charges 0%.
- **Nothing is lost by closing.** The Safe address is deterministic; re-initializing restores
  control of every remaining token account and position.

Instructions by role:

| Role | Instructions |
|---|---|
| Owner | `initialize`, `initialize_with_limits`, `deposit`, `deposit_spl`, `withdraw`, `withdraw_spl`, `set_allocation`, `set_agent`, `set_executor_limits`, `set_allowed_programs`, `execute_swap_cpi`, `execute_protocol_cpi`, `init_exponent_position`, `set_exponent_policy`, `deposit_onyc`, `withdraw_onyc`, `recover_exponent`, `close_empty_token_account`, `withdraw_excess_lamports`, `close_safe` |
| Owner or approved executor, within limits | `kamino_deposit`, `kamino_withdraw`, `exponent_buy_pt`, `exponent_sell_pt`, `exponent_redeem_pt` |
| Admin | `init_config`, `set_config` (treasury, fee ≤ 20%), `init_executor_registry`, `set_executor_registry` |
| Anyone | `create_safe_for` (sponsored Safe creation; the PDA is bound to the owner), transfers into the Safe |

## What is live, and what is not

| Component | Status |
|---|---|
| Safe program, owner deposit and withdrawal | Mainnet |
| Executor registry and per-Safe limits | Mainnet |
| Kamino flexible: entry and exit by owner and by executor | Mainnet, with transaction receipts in [`docs/`](docs/) |
| Exponent fixed: entry and early exit | Mainnet pilot |
| Mobile transaction API: unsigned plans, preflight, Lighthouse assertions, priority-fee cap | Mainnet ([spec](docs/yield-ai-v2-owner-protocol-api.md)) |
| Android app with Mobile Wallet Adapter / Seed Vault | Mainnet ([repo](https://github.com/ssadkov/yield-ai-mobile)) |
| USDC from Base via Circle CCTP into the Safe | Testnet only |
| Safe owned by an EVM address (EIP-712 signatures, relayer) | Devnet only |
| Upgrade authority in a Squads 2-of-3 multisig with timelock | Rehearsed on devnet; mainnet authority is still a single key |
| Autonomous agent with a decision journal | Not built yet |

### Deployed binary

| | |
|---|---|
| Installed ELF SHA-256 | `48da204eea62b79db16474045a2ede6e139c54e4d1023f99b09dfc3adfe7565d` (690,944 bytes) |
| Last upgrade | slot 453510076, [transaction](https://solscan.io/tx/4VcAVvujJXqwJ13wnJU6YHpwEWGHQhahvFrSmcw8DnfeBJQ3Gu7PppVjhXkigfssZzsxxwdcsfgvQWLgQMjKzJg4) ([record](docs/yield-ai-v2-exponent-dynamic-ticks.md)) |
| Upgrade authority | `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A` (single key) |

The hash was re-checked against a fresh mainnet dump on 2026-10-12. The deployed source is
`main` without one later instruction, `refund_excess_lamports`, which is **not deployed**. The
build is not yet registered as a verifiable build (OtterSec); that, the multisig and a
`security.txt` come with the next program upgrade.

## How a deposit works

```
 Phone wallet (Seed Vault / Phantom / Solflare over MWA)
        │  one signature per action; the user is the only signer and fee payer
        ▼
 Yield AI API (web/) ── builds an unsigned plan; the app checks programs, accounts,
        │               network and blockhash before asking for a signature
        ▼
 yield_vault program (yie1…)
        ├─ Safe PDA ["vault", owner]  ─ owner, agent, allocation, route principal
        ├─ Safe token accounts        ─ authority = Safe PDA
        ├─ Kamino kVault shares       ─ flexible
        └─ Exponent PT position       ─ fixed, with max-loss / max-slippage policy
```

Flexible deposit is atomic: wallet → Safe → Kamino in one transaction.

## Repository

| Path | What |
|---|---|
| [`programs/yield-vault`](programs/yield-vault/) | Anchor program: Safe, executor limits, Kamino and Exponent instructions, unit tests |
| [`web/`](web/) | Next.js app and API routes, including the mobile v1 API |
| [`client/`](client/) | TypeScript probes and operator scripts |
| [`docs/`](docs/) | Design notes, mainnet receipts, API specs ([start here](docs/yield-ai-v2.md)) |

## Build and test

- Rust from [rust-toolchain.toml](rust-toolchain.toml) (1.89.x), Anchor CLI **0.32.1**, Solana /
  Agave CLI **3.1.12**. On Windows, build in WSL.

```bash
cargo test -p yield-vault        # program unit tests
anchor build                     # ELF and IDL in target/
```

The web app: copy [`web/.env.local.example`](web/.env.local.example), then `npm install` and
`npm run dev` in `web/`. Network, program ID and RPC are set there.

## Business model

A performance fee on realized profit for enabled routes, configured per route and capped at 20%
in the program. The Exponent pilot charges no fee. Live fee settlement on positive profit is still
being validated.

## Roadmap

1. Move upgrade authority to a Squads multisig with a timelock; publish a verifiable build.
2. USDC in from EVM chains: CCTP into the Safe, then Safes owned by an EVM address so users
   without a Solana wallet can deposit and withdraw.
3. An executor that rebalances within the owner's limits and records why it acted.
4. More strategies on the same rails, including delta-neutral positions requested by our larger
   depositors.

## Prior work

Yield AI started on Aptos (live, see DefiLlama above). An earlier Solana vault program
(`3Vtz…`) is closed. The v2 Safe program, executor limits, Kamino and Exponent integrations, the
mobile API and the Android app were built during the hackathon, from 2026-09-23.

## Team

| Name | Role |
|---|---|
| Sergei Sadkov | Founder, product and core development. Built and sold AutoOffice, a SaaS CRM with 200,000+ users. [X](https://x.com/ssadkov) · [YouTube](https://www.youtube.com/@crypto_rentier) |
| Andrey Aniskov | Core developer: Jupiter and Kamino integrations |
| Alexander Rybakov | Marketing and growth. [X](https://x.com/rybakov_alv) |

Mobile app contributors are listed in [its README](https://github.com/ssadkov/yield-ai-mobile).
