# Jupiter Developer Platform — Developer Experience Report

**Project:** Yield AI (agent-safe vault + automation on Solana)  
**Repository / demo:** see [README.md](README.md) for live app, video, and program links.  
**Report date:** 2026-05-12  

**Developer Platform organization (paid plan):**  
`oihusBdPFaAc4mp6V54J4qqsCqT7jodV` — **Developer Plan** purchased on this org (used for API key + quota during the Frontier / Superteam build).

---

## 1. What we shipped (and how Jupiter fits)

Yield AI is a **non-custodial PDA vault** with an **on-chain allowlist** of programs the automation layer may CPI into. Users keep withdrawal keys; an **agent** pubkey can only execute **whitelisted** actions.

### Swaps: Jupiter inside the vault program (not “swap in the web server only”)

Our Anchor vault exposes **`execute_swap_cpi`**: the outer program verifies the inner instruction targets a **whitelisted program ID**, then performs the CPI with **vault PDA `invoke_signed`**.

For Jupiter routing we use **Swap API V2 — `GET /swap/v2/build`** (`https://api.jup.ag`) to obtain **raw setup + swap (+ cleanup) instructions** and address lookup tables. Those instructions are **not executed as a normal wallet swap**; they are **fed into the vault instruction stream** (wrapped as CPIs into `execute_swap_cpi`) so the **vault remains the taker** while a separate **authority** pays fees/rent where the route requires it.

The **AI agent** (product layer) is used to **orchestrate user intent** (rebalance, convert-all, one-off swaps): it proposes the flow, surfaces missing allowlist programs (`needs_whitelist`), and drives the same server builders that call Jupiter’s `/build` endpoint. In other words: **Jupiter supplies the route; our program enforces custody + allowlist; the agent supplies UX and sequencing.**

### Other Jupiter surfaces we use

| Surface | How we use it |
|--------|----------------|
| **Price API** (`/price/v3`) | Portfolio valuation, risk/health UI, rebalance planning. |
| **Tokens** (via our Next.js proxies + caching) | Metadata / icons for UI (mixed with static catalog for some xStocks). |
| **Lend — SDK path** | `@jup-ag/lend/borrow` for **Borrow `Operate`** flows (collateral lend, USDC borrow, repay, withdraw, init position). |
| **Lend — read SDK** | `@jup-ag/lend-read` for **market/pool discovery** powering earn ideas and APY-style surfacing. |

We **did not** integrate Trigger, Recurring DCA, Prediction Markets, or Perps APIs in this repo for the hackathon window — scope stayed on **vault + lend/borrow loop + swap + price**.

---

## 2. Onboarding & time-to-first-successful call

**Rough timeline (honest):**

- **~15–30 minutes** from `developers.jup.ag` → first working **`/price/v3`** and **`/swap/v2/build`** calls in our server module, *once* `JUPITER_API_KEY` and mainnet RPC were wired.
- **Much longer** for **Jupiter Lend Borrow** end-to-end: not because the SDK is “broken”, but because **the repay / dust / accounting story is under-documented for integrators** (see §4).

**What helped onboarding**

- Having a **single API key** and a **single host** (`api.jup.ag`) for swap + price reduced operational friction vs hunting keys across products.
- **`llms.txt` / LLM-oriented doc index** (`https://dev.jup.ag/llms.txt`) materially sped up integration work: good for “where do I even start?” and cross-linking.

---

## 3. AI stack — what we actually used (and what we did not)

### Used

- **`llms.txt`** (and linked doc pages) while implementing Swap V2 build + wiring CPI constraints.
- **Structured “skills” / guidance files** in our repo under **`.agents/skills/`** (local Cursor/Codex workflows): Jupiter integration notes, Solana pitfalls, AI SDK patterns. This is **not** a runtime dependency of the web app, but it **did** reduce iteration time for humans + coding agents.

### Not used (honest)

We **did not** use in this project cycle:

- **Jupiter CLI** (JSON-native agent execution path) — our automation runs through **Next.js server routes + signer keypair**, not CLI orchestration.
- **Docs MCP** — we did not wire MCP into the build pipeline; browser + `llms.txt` + SDK exploration were enough to start, and time went into Lend Borrow edge cases instead.
- **Swap V2 “managed landing”** flow via **`/order` + `/execute`** (incl. gasless path) — we stayed on **`/build`** because we need **instruction-level control** to wrap into **`execute_swap_cpi`** with vault PDA signing semantics and strict allowlisting.

If Jupiter wants stronger signal on CLI/MCP: the gap for us is **“show a reference recipe: `/build` → map instructions into a PDA-owned swap CPI with allowlist checks”** — that’s a common Solana integrator shape and would push more teams to try CLI/MCP as a codegen + verification layer.

---

## 4. Where the APIs / docs “bit us” (high-signal)

### 4.0 Concrete documentation gaps (URLs)

These pages are the right place to capture what integrators actually hit in production — today they **do not yet carry that depth**:

- **Borrow API (marked “Soon” / WIP)** — [Borrow API](https://developers.jup.ag/docs/lend/borrow/api) currently states that the **Borrow API is a work in progress** and full documentation is **coming soon**. That matches our experience: we could not treat HTTP Borrow docs as the source of truth and fell back to **SDK + chain experimentation**.

- **Repay page should spell out submission complexity** — [Repay](https://developers.jup.ag/docs/lend/borrow/repay) should document **more than field names**: it should explain **how to construct a repay that lands on-chain safely** under interest accrual, internal precision, dust floors, and multi-instruction flows. Today integrators still reverse-engineer from program errors.

- **Doc discovery** — the documentation index at [llms.txt](https://dev.jup.ag/docs/llms.txt) helped us find entry points, but **Borrow/repay remains the weakest narrative** relative to Swap.

**Ask for Jupiter:** expand [Repay](https://developers.jup.ag/docs/lend/borrow/repay) into an **integrator cookbook** (see bullets below) and link it prominently from [Borrow API](https://developers.jup.ag/docs/lend/borrow/api) once the API stabilizes.

### 4.1 Jupiter Lend **Borrow** — repay is the hardest part

**Problem class:** max repay / dust / internal scaling / `Operate` validation (`min_user_debt`, `dustDebtRaw`, etc.) are **real**, but the **docs do not walk an integrator** through a robust “close position” recipe the way Swap docs do — and the official **Repay** page is not yet the “single source of truth” for submission edge cases ([Repay](https://developers.jup.ag/docs/lend/borrow/repay)).

**What we needed (and largely inferred):**

- Exact relationship between **SDK user units**, **9dp internal accounting**, and **what the chain validates** on repay.
- How **`MAX_REPAY` / sentinels** interact with on-chain checks (some sentinels are **not** valid `Operate` amounts — we learned by failing fast).
- How **multi-ix flows** (e.g. setup like `InitTickIdLiquidation`) must be split: **some setup cannot be funded/signed from a PDA that carries data** — we split “setup” vs final `Operate` to avoid `SystemProgram` transfer failures.

**What the [Repay](https://developers.jup.ag/docs/lend/borrow/repay) page should add (actionable outline):**

1. **Units diagram** — `debtRaw` (on-chain, scaled) ↔ user-facing repay amount ↔ SDK input after `getOperateContext` scaling; where `dustDebtRaw` enters “effective debt”.
2. **Three outcomes** — full close (what “zero” means on-chain vs UI dust), partial repay, and **dust-band** where the protocol rejects repay (`min_user_debt` / `VAULT_USER_DEBT_TOO_LOW`).
3. **Error matrix** — map common Anchor errors to “what to change in the next simulation” (too high → excess payback; too low → debt-too-low; math → collateral/LTV edge).
4. **Multi-transaction pattern** — when the SDK returns **>1 instruction**, which legs must be **fee-payer signed** vs **vault CPI**, and why `Transfer: from must not carry data` appears if you wrap the wrong leg.
5. **Position identity** — how `positionId` / NFT receipts relate to `getCurrentPosition`, and how to enumerate positions for a vault-like signer.

**DX impact:** this is where we burned the most time. A single “**Repay: three supported modes** (full, partial, dust)**” cookbook with **expected errors** would have saved days.

### 4.2 Borrow **positions as NFTs** — mental model + data retrieval

Borrow positions surface as **NFT-like position receipts** (`jvXX`-style symbols in UI). Discovering **which `positionId` belongs to which vault/market**, and keeping that stable under multi-position scenarios, was **more complex than expected**.

**What would help:**

- A clearer **“enumerate positions for owner/vault”** story in docs (or SDK helper patterns) aligned with how Jupiter represents positions on-chain.

### 4.3 Swap `/build` — works well, but allowlist UX is integrator-specific

`/swap/v2/build` itself was **solid**. The pain is mostly **product-level**: extracting **unique program IDs** from setup/swap/cleanup/other legs and asking the user to **approve allowlist updates** — predictable, but not spelled out as a “happy path” in Jupiter docs for **vault-style signers**.

---

## 5. What we did **not** use from the Jupiter docs / platform (explicit)

To avoid ambiguity for reviewers:

- **Trigger API** (limit / TP-SL / OCO) — not integrated.
- **Recurring / DCA API** — not integrated.
- **Prediction markets API** — not integrated.
- **Perps API** — not integrated.
- **Lend HTTP APIs** beyond what’s implied by our usage — we relied on **`@jup-ag/lend` / `@jup-ag/lend-read` SDKs** for borrow/read instead of building everything via REST.
- **Swap V2 `/order` + `/execute` managed flow** — not used; **`/build` only**.

---

## 6. If we were building `developers.jup.ag` (platform UX)

**Highest leverage improvements for teams like ours:**

1. **“Vault / PDA / CPI wrapper” playbook** for Swap V2 `/build` (instruction budgets, allowlist extraction, who pays rent/fees).
2. **Borrow repay cookbook** with **error matrix** (`EXCESS_PAYBACK`, `USER_DEBT_TOO_LOW`, math errors) and **SDK + on-chain** units spelled out.
3. **SDK-first navigation** in docs: “If you’re integrating Borrow, start here” with **end-to-end** repo-shaped examples (deposit → borrow → repay max → withdraw).

---

## 7. What we wish existed

- **First-class “close borrow position” helper** in the Borrow SDK (or a documented recipe) that handles **dust**, **interest drift**, and **sentinel amounts** safely.
- A small **“position discovery”** utility or documented algorithm for vault-held NFT positions across markets.
- A documented **minimum integration checklist** for Developer Plan teams: which endpoints are safe for server agents, rate limits, and recommended retry patterns (429 backoff).

---

## 8. Summary

- **Swap + Price** on the Developer Platform were the **fast, reliable** parts of the integration.
- **Borrow repay + position modeling** was the **slow, doc-thin** part — we shipped, but it required more reverse-engineering than it should.
- We used **`llms.txt` + local agent skills** heavily; we **did not** adopt CLI/MCP in this cycle; we stayed on **`/build`** by necessity for vault CPI wrapping.

We want Jupiter to win the “one platform” story — the paid plan already improved day-to-day velocity for us; the biggest ROI now is **deeper integrator cookbooks for Lend Borrow** (especially repay/close) and **PDA swap patterns** for `/build`.
