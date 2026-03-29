# 🧠 Yield AI — Solana AI Vault (MVP Spec)

## Overview

Build an MVP of an AI-managed vault on Solana.

The system:
- accepts **USDC deposits only**
- builds a portfolio using **Jupiter swaps**
- rebalances **once per hour via an offchain agent**
- supports predefined strategies
- operates through a **PDA-controlled vault (safe)**

No ETH exposure. No manual staking. Only token allocation via swaps.

---

## 🎯 Core Idea

User deposits USDC → funds go into a **vault (PDA)** →  
AI agent allocates capital into a portfolio via **Jupiter swaps** →  
agent rebalances portfolio every hour based on strategy.

---

## 🏗 Architecture

### Components

1. **Vault Program (onchain, Anchor)**
2. **PDA Safe (token account owner)**
3. **Offchain AI Agent (Node.js / Python)**
4. **Jupiter API (routing + swap execution)**

### Clusters (important)

- **Program development / unit tests:** local validator (localnet) or standard `anchor test` flow.
- **Jupiter swaps:** target **mainnet-beta** for realistic routes and liquidity (Jupiter is not a substitute on devnet for production-like integration). Use dedicated RPC, `JUPITER_API_KEY`, simulation, and small amounts — real funds and fees apply.

### Phase 1 — custody before swaps

Vault must support **user deposit** and **user withdraw** (owner-only) of USDC from/to the user’s ATAs. On initialization (or a dedicated instruction), store the **`agent` pubkey** as the **designated off-chain executor** for future swap/rebalance instructions (the agent does not withdraw user funds unless explicitly allowed by a later instruction design).

---

## 🔐 Vault Design

### PDA

Each user has a vault:
vault_pda = PDA(user_pubkey, "vault")


Vault stores:
- USDC
- portfolio tokens

---

### Vault State

```rust
pub struct Vault {
    pub owner: Pubkey,
    pub strategy: StrategyType,
    pub allowed_tokens: Vec<Pubkey>,
    pub last_rebalance_ts: i64,
}
💰 Supported Assets (Whitelist)
Only these tokens are allowed:

USDC      — base asset
USDY      — yield stable (~5%)
USDe      — delta-neutral (~5–9%)
sUSDe     — staked (~8–12%)
cbBTC     — BTC exposure
xStocks   — tokenized equities (SPY / S&P500)
⚠️ No ETH in any form.
📊 Strategies (Hardcoded v1)
1. Conservative
60% USDC
40% USDY
2. Balanced
30% USDC
30% USDY / sUSDe
20% cbBTC
20% xStocks (SPY)
3. Growth
10% USDC
20% sUSDe
35% cbBTC
35% xStocks (SPY)
🔁 Rebalancing Logic
Runs offchain
Trigger: every 1 hour
Agent checks current allocations
If deviation > threshold (e.g. 5%) → rebalance
Rebalance Flow
1. Fetch vault balances
2. Compute current allocation
3. Compare vs target
4. Generate swaps
5. Execute swaps via Jupiter
🔄 Jupiter Integration
Important
- Use **Jupiter API (offchain)** for quotes, routing, and swap instruction data / account metadata the vault needs to execute safely.
- **CPI is required on-chain:** the vault program performs swaps by **CPI into whitelisted programs only** (Jupiter router and any DEX programs the route requires — all must be in `allowed_program_ids` / protocol whitelist). The PDA signs token flows via **`invoke_signed`** inside the vault program. No SPL Token delegate-to-agent pattern for unrestricted transfers; execution goes through `execute_action` (or equivalent) with protocol checks.
- Offchain API builds the route; **on-chain execution** is still one or more transactions that hit Solana programs — the vault is the controlled entry point.

Flow
Agent:
  → requests route from Jupiter API
  → passes validated swap parameters / instruction payload to the vault program (per IDL)

Vault program:
  → validates caller (agent or owner), tokens, and target program IDs
  → executes swap via **CPI** into allowlisted programs (Jupiter + route legs)
  → PDA signs via invoke_signed where needed
🔐 Security Model
Restrictions
Vault program MUST enforce:

allowed tokens only
allowed protocols only
no arbitrary instructions
Execution Entry
pub fn execute_action(ctx, action: Action)
Action Types
Swap {
    from_token: Pubkey,
    to_token: Pubkey,
    amount: u64,
}
Checks
require!(token_in_whitelist)
require!(protocol_in_whitelist)
require!(caller == agent || owner)
🤖 AI Agent
Responsibilities
fetch prices (Pyth / Jupiter)
fetch balances
compute allocation
decide rebalance
execute swaps
Loop
while true:
    sleep(1 hour)
    check all vaults
    rebalance if needed
AI Layer (MVP)
Initially rule-based:

if deviation > 5%:
    rebalance
Later extend to:

volatility-aware
yield-aware
funding-aware
📦 Token Handling
All tokens are SPL tokens
No SOL required from user
Gas can be:
sponsored
or paid by agent
🚫 What NOT to Build (MVP scope)
❌ no ETH / wETH / bridges
❌ no lending integrations
❌ no staking logic
❌ no onchain price triggers
❌ no CPI to programs outside the vault whitelist (no arbitrary aggregators/DEX calls)
🚀 MVP Goals
user deposits USDC
selects strategy
vault created
agent executes swaps via Jupiter
portfolio matches strategy
rebalancing works every hour
🧠 Future Extensions
dynamic AI strategies
yield optimization across protocols
multi-chain support (Aptos + Solana)
permissioned agents
private vaults
⚙️ Dev Setup (Cursor)
Install Solana skill:

npx skills add https://github.com/solana-foundation/solana-dev-skill
Recommended stack:

Anchor
@solana/web3.js
Jupiter API
Node.js agent
✅ Definition of Done
vault PDA created
USDC deposit works
strategy stored
swaps execute via Jupiter
balances update correctly
agent rebalances every hour
🧩 Key Insight
This is NOT just a vault.
This is:

an execution layer for AI-driven portfolio management


