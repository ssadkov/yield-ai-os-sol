# Yield AI — Agent-safe execution on Solana

[![Solana](https://img.shields.io/badge/Solana-mainnet-9945FF)](https://solana.com)
<!-- [![License: MIT](https://img.shields.io/badge/License-MIT-14F195.svg)](LICENSE) — add LICENSE at repo root, then uncomment -->
<!-- [![CI](INSERT_CI_BADGE_MARKDOWN)](INSERT_CI_ACTIONS_URL) -->
<!-- [![Hackathon](INSERT_HACKATHON_BADGE_MARKDOWN)](INSERT_HACKATHON_URL) -->

> **Yield AI is an agent-safe execution layer for Solana.** A PDA vault with a **program allowlist** lets AI agents put user capital to work **without ever holding the keys**. **Live on mainnet today**, with a working consumer flow that **earns USDC yield on stock positions without selling them**.

[Live app](https://yield-ai-os-sol.vercel.app/) · [Demo video](https://youtu.be/_a5KCpidm6Y) · [Deck](https://docs.google.com/presentation/d/1uNP_oQGHiexqK5tfzzEXstdt2RMw7j-J5KfFZZaSuXw/edit?usp=sharing) · [Hackathon submission](https://arena.colosseum.org/projects/explore/yield-ai) · [Vault program (Anchor IDL)](https://orbmarkets.io/address/3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s/anchor-idl) · [X](https://x.com/yieldai_app)

---

<!-- ![Hero screenshot](INSERT_PATH_TO_SCREENSHOT.png) -->

## Hackathon / submission

| Name | Role | Notes |
|------|------|-------|
| Sergei Sadkov | CEO and core developer | [YouTube](https://www.youtube.com/@crypto_rentier) · [X](https://x.com/ssadkov) · [Telegram](https://t.me/ssadkov) · Superteam Kazakhstan |
| Andrey Aniskov | Core developer | Integrations: Jupiter + Kamino |
| Alexander Rybakov | Marketing & growth | [X](https://x.com/rybakov_alv) |

---

## Problem → solution

| # | Problem | How Yield AI addresses it |
|---|---------|---------------------------|
| 1 | **AI + capital = custody risk** — users fear sending funds to an opaque “agent wallet.” | Funds stay in a [**vault PDA**](https://orbmarkets.io/address/3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s/anchor-idl); there is **no private key** for the vault authority. |
| 2 | Automation needs **on-chain execution**, not chat-only advice. | A designated **agent** pubkey can drive **whitelisted CPIs**; **withdrawals stay owner-only**. |
| 3 | Open-ended CPIs are dangerous. | **`execute_swap_cpi`** only targets **`allowed_programs`** (max 16), controlled by the owner. |
| 4 | Users want **yield** without necessarily exiting risk assets (e.g. tokenized equities). | **Mainnet** consumer flow: strategy targets, Jupiter routing, and integrations for **USDC yield** while retaining vault-held positions (see live app and technical section below). |

---

## Why Solana

- **Native custody model** — PDAs + `invoke_signed` for non-custodial vaults agents can interact with.
- **Composability** — one vault, many protocols; the allowlist is how automation **safely** opens that surface.
- **Market depth** — access to RWAs (e.g. tokenized equities) and a large ecosystem of DeFi protocols with deep on-chain liquidity.

**RWA momentum & liquidity** — Solana’s RWAs (e.g. **xStocks**, **OnRe**) plus deep **Kamino** and **Jupiter** liquidity make it a strong fit for **managed-yield retail flows** that keep users in risk assets while harvesting stablecoin yield.

---

## What ships today (summary)

- **Anchor vault** — [PDA custody](https://orbmarkets.io/address/3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s/anchor-idl), owner withdrawals, allowlisted CPI execution path for the agent.
- **Next.js app (`web/`)** — wallet + deposit, vault lifecycle, portfolio charts, **strategy rebalance / convert-all**, **Kamino kVault** earn/withdraw, **Jupiter Lend** collateral + borrow/repay USDC flows, and **Earn Ideas** cards (server-backed APY hints) — [live app](https://yield-ai-os-sol.vercel.app/).
- **Jupiter** — Price API, Swap V2 build for vault CPI swaps, Lend/Borrow SDK usage from server routes.
- **Kamino** — kVault deposit/withdraw + position reads for the vault UI.
- **Birdeye** — historical candles for token charts.

---

## Tech stack (summary)

| Layer | Stack |
|-------|--------|
| On-chain | Rust · Anchor |
| App & APIs | Next.js · React · TypeScript |
| Wallet | Solana Wallet Adapter |
| AI / automation | Vercel AI SDK · OpenRouter · **optional** chat UI (`SHOW_AI_CHAT` in `web/src/config/features.ts`) · Earn Ideas + rebalance orchestration in `web/src/server/agent/` |
| Liquidity / routes | Jupiter API (swap build, prices) · Jupiter Lend (`@jup-ag/lend`, `@jup-ag/lend-read`) |
| Yield protocols | Kamino (kVaults) |
| Market data | Birdeye (charts) |

---

## Live application (`web/`)

The dashboard is a **three-column** layout driven by [`web/src/app/page.tsx`](web/src/app/page.tsx):

| Column | What runs |
|--------|-------------|
| **Wallet** | `DepositCard`, `WalletAssetsCard` — connect wallet, deposit to vault, see wallet balances. |
| **Vault** | `CreateVaultCard`, `VaultCard` — initialize vault, holdings, allocation chart, **rebalance / convert-all**, **Kamino kVault** loop, **Jupiter Lend** borrow/repay/collateral actions, Birdeye chart. |
| **Ideas / assistant** | `EarnIdeasCards` — always-on **Earn Ideas** (calls `GET /api/earn-ideas`). **`AIChat`** is **gated** by `SHOW_AI_CHAT` in [`web/src/config/features.ts`](web/src/config/features.ts) (currently `false` for the public demo). |

Server logic for swaps, rebalance, Kamino, and Jupiter Borrow lives under [`web/src/server/agent/`](web/src/server/agent/) and is invoked from `web/src/app/api/**` routes — there is **no separate production “agent service”** for the live app.

---

## Quick start (demo + local)

```bash
git clone https://github.com/ssadkov/yield-ai-os-sol.git
cd yield-ai-os-sol

anchor build

cd web
npm install
cp .env.local.example .env.local   # then fill RPC, program id, optional API keys (see below)
npm run dev
```

Env and RPC: see **Environment variables** in the technical section below. Full spec: [what-we-build.md](what-we-build.md).

---

## Roadmap

- [x] PDA vault + owner withdraw + allowlisted agent CPI path
- [x] Next.js dashboard + Jupiter-backed rebalance
- [ ] More strategies (preset + custom) and strategy marketplace
- [ ] Open SDK for third-party agents and strategies (revenue share)
- [ ] Cron-driven automation: scheduled rebalance / risk checks / auto-exit
- [ ] AI agent cost optimization (caching, smaller models, structured routing)
- [ ] Solana Seeker app publication + deeper mobile ↔ vault flows (wallet connect demo: https://youtube.com/shorts/QRY5nAQKfqY)
- [ ] AI chat with confirm-gated tools + allowlist update flow (post-hackathon; currently hidden in UI for demo)

---

## License

MIT — add a `LICENSE` file at the repository root when you publish the repo publicly.

---

## Resources

- [Live app](https://yield-ai-os-sol.vercel.app/)
- [Demo video](https://youtu.be/_a5KCpidm6Y)
- [Deck](https://docs.google.com/presentation/d/1uNP_oQGHiexqK5tfzzEXstdt2RMw7j-J5KfFZZaSuXw/edit?usp=sharing)
- [Hackathon submission](https://arena.colosseum.org/projects/explore/yield-ai)
- [Vault program (Anchor IDL)](https://orbmarkets.io/address/3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s/anchor-idl)
- [X / @yieldai_app](https://x.com/yieldai_app)

---

## Technical documentation

The sections below are the **developer-focused** reference (program instructions, architecture diagram, API list, env vars, toolchain).

## 🚀 What it does today

### ⛓️ On-chain vault (Solana / Anchor)
The vault program is the **security boundary**. Funds live in SPL token accounts controlled by a **Program Derived Address (PDA)** tied to the user. Program + Anchor IDL on Orb: [3Vtz…WEFp5s](https://orbmarkets.io/address/3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s/anchor-idl).

**Instructions**
- **`initialize(agent, strategy, allowed_programs)`**
  - Creates a per-owner vault PDA.
  - Stores the vault owner, the designated `agent` pubkey, the strategy, and an allowlist of CPI program IDs (`allowed_programs`, max 16).
  - Creates the vault USDC ATA (authority = vault PDA).
- **`deposit(amount)`**: Transfers USDC from the owner’s USDC ATA into the vault USDC ATA.
- **`withdraw(amount)`** (**owner-only**): Transfers USDC from the vault USDC ATA back to the owner via `invoke_signed` (PDA authority).
- **`withdraw_spl(amount)`** (**owner-only**): Same as `withdraw`, but for **any SPL/Token-2022 mint** (pulls from a vault-owned token account to the owner’s ATA for that mint).
- **`set_allowed_programs(allowed_programs)`** (**owner-only**): Updates the CPI program allowlist (max 16).
- **`execute_swap_cpi(data)`**: Performs a CPI into a **whitelisted** program ID using `invoke_signed`. Caller must be either `Vault.owner` or `Vault.agent`.

### 💻 Web app (Next.js)
A dashboard to manage the vault and visualize portfolio state (see **Live application (`web/`)** above for the layout).

- **Wallet (Solana Wallet Adapter)**: connect + sign transactions (initialize, deposit, withdraw, allowlist updates, swaps, Kamino, Jupiter Borrow legs).
- **Portfolio**: wallet vs vault holdings, allocation chart, token chart (Birdeye).
- **Earn Ideas**: curated loops (e.g. collateral → borrow USDC → Kamino) with **explicit user confirmation** per step; uses `/api/earn-ideas` and the same rebalance / protocol builders as the vault card.
- **Yield reads**: `/api/yields` and earn-ideas path for APR/APY hints where available.

### Earn Ideas vs AI chat
- **Earn Ideas (`EarnIdeasCards`)** — **shipped in the live UI**; orchestrates multi-step flows with clear labels and signatures.
- **AI chat (`AIChat`, Vercel AI SDK + OpenRouter)** — **optional**; enable by setting `SHOW_AI_CHAT` to `true` in [`web/src/config/features.ts`](web/src/config/features.ts). When on, it is grounded on live snapshots and only executes after explicit confirmation (`rebalance`, `convert_all`, individual swaps). If a Jupiter route needs extra programs, responses include `needs_whitelist` + missing program IDs for `set_allowed_programs`.

---

## 🧩 Architecture (for GitHub)
Production behavior matches the **Next.js app in `web/`**: React UI → `web/src/app/api/*` routes → `web/src/server/agent/*` (rebalance engine, vault swap build, Kamino, Jupiter Lend borrow) → external APIs and Solana RPC → **user-signed** transactions against the vault program (`execute_swap_cpi`, deposits, withdraws, etc.).

A standalone [`agent/`](agent/) Node package remains for **local experiments**; it is not required to run the live dashboard.

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser — web/src/app (React, Wallet Adapter)                  │
│  page.tsx → components → hooks                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │ fetch / sign
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Next.js API — web/src/app/api/*                                │
│  rebalance, earn-ideas, jupiter/*, kamino/*, vault-holdings, … │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Server modules — web/src/server/agent/*                        │
│  rebalance engine · buildVaultSwapTx · kaminoKvault · jupiterBorrow │
└───────────────┬─────────────────────────────┬────────────────────┘
                │                             │
                ▼                             ▼
        Jupiter / Kamino / Birdeye              Solana RPC
                │                             │
                └──────────────┬──────────────┘
                               ▼
                ┌──────────────────────────────┐
                │  Vault program (Anchor) + PDAs│
                │  allowlisted CPI only       │
                └──────────────────────────────┘
```

Swaps and protocol legs execute as **CPI from the vault** into **allowlisted program IDs** (Jupiter router, route legs, SPL Token, plus Kamino / Jupiter Lend programs once added to the owner’s list).

---

## 🔐 Security model (high-level)
- **PDA custody**: vault token accounts are owned by a PDA; no private key exists for the vault authority.
- **Owner-only withdrawals**: `withdraw` and `withdraw_spl` require the `owner` signer.
- **CPI allowlist**: swaps are executed only via CPI into **explicitly whitelisted program IDs** (`allowed_programs`), reducing the “arbitrary instruction” attack surface.
- **Agent is not a custodian**: the `agent` can execute swaps (when allowed), but cannot withdraw funds.
- **Explicit user intent for execution**: chat proposes actions and requires explicit confirmation before running them.

---

## 📦 Repo structure (where things live)
- `programs/yield-vault/`: Anchor program (vault + CPI execution)
- `web/`: Next.js app (UI + API routes + “agent” server modules)
- `client/`: TypeScript smoke tests (initialize/deposit/withdraw)
- `agent/`: standalone Node package (dev/experiments; not required for production MVP)

---

## 🌐 Web API routes (current)
Routes live under [`web/src/app/api/`](web/src/app/api/):

| Method | Path | Role |
|--------|------|------|
| `POST` | `/api/chat` | Streaming AI chat + tool hooks (when chat UI is enabled). |
| `POST` | `/api/rebalance` | Build/sign flow for rebalance and convert-all. |
| `POST` | `/api/cron/rebalance` | Same as rebalance; requires `x-cron-secret`. |
| `GET` | `/api/earn-ideas` | Server-composed earn ideas (APY / pool hints) for the UI cards. |
| `GET` | `/api/vault-history?owner=<pubkey>` | Deposit / withdraw history summary. |
| `GET` | `/api/vault-holdings` | Aggregated vault token view for the dashboard. |
| `GET` | `/api/yields` | Yield / APY payload for selected tokens. |
| `GET` / `POST` | `/api/jupiter/prices` | Token prices (cached RPC `getAssetBatch`). |
| `GET` / `POST` | `/api/jupiter/tokens` | Token metadata (cached). |
| `GET` | `/api/protocols/jupiter/borrowLend` | Jupiter Lend / borrow-lend market payload for UI. |
| `GET` | `/api/jupiter/borrow/positions` | Borrow positions for the connected vault context. |
| `POST` | `/api/jupiter/borrow/borrow-usdc` | Build borrow leg (unsigned tx / ix for wallet). |
| `POST` | `/api/jupiter/borrow/repay-usdc` | Build repay leg. |
| `POST` | `/api/jupiter/borrow/deposit-collateral` | Collateral deposit leg. |
| `POST` | `/api/jupiter/borrow/withdraw-collateral` | Collateral withdraw leg. |
| `GET` | `/api/kamino/kvault/positions` | Kamino kVault positions. |
| `POST` | `/api/kamino/kvault/deposit` | kVault deposit tx build. |
| `POST` | `/api/kamino/kvault/withdraw` | kVault withdraw tx build. |
| `GET` | `/api/birdeye/history?address=<mint>&type=4H&time_from=...&time_to=...` | Historical candles (rate-limited). |

---

## 🛠️ Development & deployment

### Prerequisites
- Rust + `cargo`; use [rust-toolchain.toml](rust-toolchain.toml) (**1.89.x** for Anchor **0.32** IDL). Run `rustup toolchain install 1.89.0` if prompted; use `rustup override unset` in this repo if an old override hides the toolchain file.
- [Anchor](https://www.anchor-lang.com/docs/installation) CLI **0.32.1** — match [Anchor.toml](Anchor.toml) `anchor_version` (`avm install 0.32.1 && avm use 0.32.1`).

### Solana / Agave CLI and `cargo-build-sbf` (recommended)
Older **platform-tools** can ship an old Cargo version that cannot parse some modern manifests.
Install a current **Agave** release so `cargo-build-sbf` uses a new enough toolchain (e.g. platform-tools **v1.52** with **rustc 1.89**).

```bash
# Optional: remove stale install/cache (only if you are fixing a broken toolchain)
rm -rf ~/.cache/solana
rm -rf ~/.local/share/solana/install

# Install Agave / Solana CLI (stable)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

solana --version
cargo-build-sbf --version   # expect platform-tools v1.52+ / rustc 1.89+ in the output
```

Then align [Anchor.toml](Anchor.toml) `solana_version` with the version `anchor build` expects. After upgrading CLI: `cargo clean` and `anchor build` from the repo root.

### Build the program

```bash
anchor build
```

Match CLI versions to [Anchor.toml](Anchor.toml) (`anchor_version` / `solana_version`). Example with **avm**:

```bash
avm install 0.32.1
avm use 0.32.1
```

### Deploying to devnet
1. Set cluster + get SOL

```bash
solana config set --url devnet
solana airdrop 2
solana balance
```

2. Keep program ID in sync
- `declare_id!` in `programs/yield-vault/src/lib.rs`
- `[programs.devnet]` in `Anchor.toml`
- keypair at `target/deploy/yield_vault-keypair.json`

3. Deploy

```bash
anchor build
anchor deploy --provider.cluster devnet
```

### Client: devnet smoke test (TypeScript)
The [`client/`](client/) package runs **`initialize`** (Conservative, empty allowlist), **`deposit`**, and **`withdraw`** on devnet.

The script loads the IDL from `target/idl/yield_vault.json`. Run `anchor build` from the repo root if the file is missing or after changing the Rust program.

---

## ⚙️ Environment variables (selected)
Use [`web/.env.local.example`](web/.env.local.example) as the template for the dashboard (`cp` step in Quick start). [`client/.env.example`](client/.env.example) and [`agent/.env.example`](agent/.env.example) cover the TypeScript smoke client and the standalone agent package.

**Web (`web/`)**
- `NEXT_PUBLIC_RPC_URL`: Solana RPC endpoint (often a Helius URL for token metadata/prices)
- `NEXT_PUBLIC_PROGRAM_ID`: vault program ID
- `OPENROUTER_API_KEY`: LLM access for chat
- `JUPITER_API_KEY`: Jupiter API key for quote/build
- `CRON_SECRET`: shared secret for `/api/cron/rebalance` (`x-cron-secret` header)

**Standalone agent (`web` server modules / `agent/` package)**
- `AUTHORITY_SECRET_KEY`: authority keypair used for sending transactions (JSON array or base58 secret key)
- `SLIPPAGE_BPS`: swap slippage in bps

---

## Spec
See [what-we-build.md](what-we-build.md) for the MVP architecture spec.
