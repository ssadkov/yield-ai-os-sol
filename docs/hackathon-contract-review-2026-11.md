# Solana Safe contract review for the NEAR Hackathon (2026-11)

Review date: 2026-11-03. Reviewer: Claude Code, at Sergei's request. This is a read-only review. No program code was changed, nothing was deployed, and no keys or mainnet funds were touched.

**What was reviewed**

- Source: `main` at commit `6d4030d` (2026-10-13). The program source last changed in `f91cf72` (2026-10-05). Files: `programs/yield-vault/src/lib.rs`, `exponent.rs`, `exponent_accounts.rs`, plus `web/src/lib/vault.ts`, `agent/` and the docs listed in the task.
- Live program, read-only via public RPC at slot 465042724 (2026-11-03): program `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`, ProgramData `GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY`. The last deploy was at slot 453510076. The first 690944 bytes of code have SHA-256 `48da204e…7565d`, which matches the hash recorded for the 2026-10-05 upgrade in `docs/yield-ai-v2-exponent-dynamic-ticks.md`. **Not checked:** that `6d4030d` builds to that exact ELF. There is no Solana/Anchor toolchain in this container. `cargo test -p yield-vault --lib` passes 15/15 host tests.
- Audit: I found no audit report or audit mention in the repo. Treat the program as **unaudited**.

## Recommendation

**Before 2026-11-14:** don't upgrade the program. Build the hackathon flow on instructions that are already deployed. A sponsored `create_safe_for` or `initialize_with_limits` creates the Safe. NEAR 1-Click pays USDC into the Safe's USDC ATA. The AI plan becomes one owner-signed transaction: `set_allocation`, then `set_executor_limits`, then `init_exponent_position` or `set_exponent_policy` with a tight `max_loss_bps`. The agent then calls `kamino_deposit` and `exponent_buy_pt`, which already enforce allocation and per-action / 24h / principal limits on-chain. Spend contract-side time on three operational items instead:

1. Move the upgrade authority and config admin off the single hot key `8xwj…` to a Squads multisig before outside users or judges deposit.
2. Keep every Safe's CPI allowlist empty, and delete the legacy `DEFAULT_ALLOWED_PROGRAMS` paths.
3. Test the 1-Click → Safe payout with about $1 before showing it.

**After 2026-11-14:** small hardening upgrade first (generic-CPI deny-list and invariants, `close_safe` principal guard, owner-only lamport refund, fee-change timelock). Then roll the Exponent route over to a new maturity before 2027-01-10, with a rate-based floor. Then a typed, owner-only Orca BTC LP route. Agent-run LP, Kamino leverage and anything above the 1,000 USDC default limits wait for an external audit.

**Never:** give the agent generic CPI. Put SPL Token, Token-2022, System or ATA programs in a Safe allowlist. Buy or sell PT through Jupiter. Let any agent instruction choose its own output account or set its own price floor.

The earlier plan put Orca, Exponent and Kamino leverage after 2026-11-14. That holds for Orca and leverage. It is wrong for Exponent: a typed, agent-callable PT-ONyc route has been live on mainnet since 2026-10-05, and it can be in the demo. Two caveats. Buying closes at maturity, 2027-01-10 13:00 UTC. And per `docs/yield-ai-v2-exponent-dynamic-ticks.md`, the funded owner entry/exit acceptance test for that route is still pending.

---

## 1. Security

### Actors and powers (confirmed from code)

| Actor | Can do | Cannot do |
|---|---|---|
| Upgrade authority `8xwj…` (also config admin and treasury; verified on-chain 2026-11-03) | Replace the program. That means everything: the Safe PDA signs whatever the new code says. | — |
| Config admin (`set_config`, lib.rs:385) | Set fee up to 20% (`MAX_PERFORMANCE_FEE_BPS`, lib.rs:32), change treasury, hand over admin, replace the executor registry (lib.rs:433) | Set a Safe's agent, move Safe funds |
| Owner | Everything on their Safe: deposit and withdraw any SPL to their own ATA (lib.rs:466-564), generic CPI through allowlisted programs (lib.rs:569-652), set agent, limits, allocation, allowlist, close | — |
| Agent (= `vault.agent` **and** in the admin registry, lib.rs:108-115) | `kamino_deposit` / `kamino_withdraw` (lib.rs:657-785); `exponent_buy_pt` / `sell` / `redeem` USDC variants (exponent.rs:390-497); `refund_excess_lamports` (lib.rs:822-856) | Generic CPI (owner check lib.rs:571, 615); withdraw; ONyc-native Exponent actions (exponent.rs:397, 447); change any setting |
| Anyone | `create_safe_for(owner)` with safe defaults: no agent, empty allowlist, zero allocation (lib.rs:349-358) | Anything else |

What I confirmed about the points listed in the brief:

- `MAX_ROUTES=8`, `ROUTE_KAMINO_USDC=0`, `ROUTE_ONYC=1` (lib.rs:23-25).
- `withdraw_spl` is owner-signed and goes only to the owner's ATA (lib.rs:1137-1167).
- Kamino actions keep USDC and shares in Safe-owned accounts. Shares must be in the canonical ATA (lib.rs:254-262).
- The default web allowlist has no Exponent program. It also has **18 entries, while the program accepts at most 16** (vault.ts:76-95 vs lib.rs:19).

### Findings, ranked

#### CRITICAL-1: one hot key controls the upgrade authority, admin and treasury

- Evidence: ProgramData read at slot 465042724 shows upgrade authority `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`. Config PDA `8Mze…` has admin = treasury = `8xwj…` and fee 500 bps. The docs say this key lives in a WSL keyring on one laptop (`docs/yield-ai-v2-handoff.md`). Moving it to Squads has been on the plan since 2026-09-23 (`docs/yield-ai-v2.md:76`) and is not done.
- Exploit: someone who steals that key deploys a program whose `withdraw` skips the owner check. In one transaction per Safe, the Safe PDA signs transfers of every token account to the attacker. All five mainnet Safes and the ExponentPosition PDAs are exposed.
- Fix: no code change. `solana program set-upgrade-authority` to a Squads vault, `set_config(admin = Squads vault)`, and a separate treasury wallet. A Squads timelock on upgrades also gives users a window to exit. About 1–2 hours plus multisig setup.

#### HIGH-1: owner-signed generic CPI lets the Safe PDA sign anything an allowlisted program accepts

- Evidence: `execute_swap_cpi` and `execute_protocol_cpi` (lib.rs:569-652) forward caller-chosen instruction data and accounts. They mark the Safe PDA as signer (lib.rs:590, 634) and only check: owner signature, program is in the allowlist, not the kVault program, Kamino shares ATA not passed, and no Exponent program or protected-mint account passed (`protect_generic`, exponent.rs:40-52). Outer signers are forwarded too.
- What one owner signature can make the Safe do, if the program is allowlisted:
  - **SPL Token / Token-2022:** `Transfer` out; `Approve` a delegate (the delegate drains later, outside any Yield AI transaction); `CloseAccount` to any destination; `SetAuthority(AccountOwner)` on the Safe's USDC ATA. Classic SPL Token lets an ATA's owner be changed: `spl-token` 8.0.0 `processor.rs:441-461`, and `InitializeImmutableOwner` is a no-op at `processor.rs:799-807`. After that the ATA **address** is unchanged but belongs to the attacker, so **every later NEAR 1-Click or CCTP payout to that address goes to the attacker**. It is persistent and quiet.
  - **System program:** the Safe PDA is program-owned, so a System transfer from it fails. Low impact.
  - **Jupiter, Orca, Raydium, Meteora, Phoenix, OpenBook:** the swap output or `decrease_liquidity` destination is any token account the caller names. A "swap" from the Safe's USDC to the attacker's wSOL account is enough.
- Where swap output lands in generic CPI: wherever the instruction says. There is no on-chain min-out and no destination check.
- Today's exposure: all five mainnet Safes have **empty allowlists** (verified 2026-11-03), and the v2 UI initializes with `[]` (vault.ts:138). A malicious frontend still needs only one signature: it puts `set_allowed_programs([Tokenkeg…])` and `execute_protocol_cpi(SetAuthority …)` in the same transaction. The wallet shows a call to the Yield AI program, not a token transfer from the user's wallet. Phantom's preview may not show balance changes on the Safe PDA's accounts. **Not checked:** how Phantom renders this.
- Fix (post-hackathon, about 1–2 days, upgrade, no migration):
  1. Deny-list Token, Token-2022, System, ATA, BPF loaders and this program's own ID in `set_allowed_programs` and both `execute_*`.
  2. After each generic CPI, re-read every Safe-owned token account passed in. Require: owner is still the Safe, no delegate, no close authority.
  3. Long-term, replace generic CPI with typed instructions like the Kamino and Exponent ones.
- For the hackathon: keep allowlists empty, and remove `DEFAULT_ALLOWED_PROGRAMS` / `setAllowedPrograms` from the UI (DepositCard.tsx:330, AIChat.tsx:707, useRebalance.ts:450, useVault.ts:205).

#### MEDIUM-1: the agent sets its own slippage reference, so the real floor on Exponent trades is `max_loss_bps`

- Evidence: `validate_order` checks `min_output` against `order.quoted_output`, which the caller supplies (exponent.rs:268-279). The independent bound is `check_loss`:
  - Buy: PT **face** value / 1000 ≥ (1 − max_loss) × spent (exponent.rs:422).
  - Exit: received ≥ (1 − max_loss) × basis (exponent.rs:476).
  - `max_loss_bps` can be up to 500 (exponent.rs:215-218), and the API default is 500.
- Exploit with a stolen agent key: in a Jito bundle, push the pinned Orca ONyc/USDC pool or the Exponent CLMM price, run `exponent_buy_pt` with `quoted_output = min_output = ` the worst value that passes, then unwind. On a buy, the face-value check lets the agent overpay by up to about the PT discount plus 5%. On a sell, by up to 5%. The volume cap limits it per day: `max_24h_volume_usdc`, default 1,000 USDC (lib.rs:30, 219-228), with exits charged at `max(received, basis)` (exponent.rs:478). Rough ceiling: about 5–7% of the daily cap per day, and only on Safes with ONyc allocation > 0.
- Kamino paths have no price input. A stolen key can only move USDC between the Safe and the pinned kVault and trigger fee realization on real gains.
- Fix: no code change needed for the hackathon. The plan transaction should set `max_loss_bps` to about 100. After the hackathon, add a rate-based floor (section 3).

#### MEDIUM-2: a stolen agent key can sweep Safe PDA lamports, even after the agent is revoked from the registry

- Evidence: `refund_excess_lamports` accepts `authority == vault.agent || owner`, does **not** check the registry, and lets the caller choose `reserve_lamports = 0` (lib.rs:822-856). Funds go to the caller.
- Impact: everything above rent-exempt on the Safe PDA. That is normally close to 0, but sponsor top-ups for protocol setup rent land there. The registry pause (`set_executor_registry`) does not stop it. Only the owner's `set_agent(default)` does.
- Fix: about 1 hour, upgrade. Owner-only, or agent only while in the registry and capped by an on-chain "sponsor top-up" record.

#### MEDIUM-3: the admin can raise the fee to 20%, and it applies to gains already earned

- Evidence: the fee is read from `Config` at exit time (lib.rs:746-747). `set_config` has no delay (lib.rs:385-392). An agent-triggered `kamino_withdraw` realizes the fee without the owner signing.
- Fix: a timelock on fee increases, or a per-Safe fee snapshot. About 0.5 day, upgrade, plus migration for any new Config field (or a separate PDA).

#### LOW-1: `close_safe` doesn't require zero tracked principal, so a re-created Safe pays fee on principal

- Evidence: `close_safe` closes the Vault even when `route_principal` is non-zero (lib.rs:862-877). Re-init sets `route_principal` to 0 while kVault shares remain. The next `kamino_withdraw` then counts the whole redemption as gain (`realize_exit`, lib.rs:37-46): a 5% fee on principal. For the ONyc route, the `route_principal == position.principal_usdc` check (exponent.rs:424, 479) then blocks buy and exit until `recover_exponent` runs.
- Trigger: a UI "close Safe" button with a position still open.
- Fix: `require!(route_principal == [0; 8])`. About 1 hour, upgrade.

#### LOW-2: anyone can create a Safe for any owner, which blocks `initialize`

- Evidence: `create_safe_for` is permissionless and accepts any `usdc_mint` (lib.rs:349-358, 982-1006). Afterwards `initialize` / `initialize_with_limits` fail because the account is already in use.
- Impact: griefing only. Defaults are safe and rent goes to the owner on close. The UI must detect an existing Safe and fall back to `set_agent` + `set_executor_limits` + `set_allocation`.

#### LOW-3: stale clients point at a v1 trust model

- `DEFAULT_ALLOWED_PROGRAMS` (vault.ts:76-95) has 18 programs, so every `set_allowed_programs` with it fails (`TooManyPrograms`, lib.rs:447-450). It also includes SPL Token, Token-2022, ATA and System. Trimming it to 16 would re-open HIGH-1. Delete it.
- `agent/` wraps Jupiter instructions in `execute_swap_cpi` signed by the agent (agent/src/swap/buildVaultSwapTx.ts:155-172). v2 rejects that (lib.rs:571). It is dead code, but it describes the model that `docs/yield-ai-v2.md:15` calls unsafe. Don't revive it.

#### INFO: checked and found sound

- PDA seeds `["vault", owner]` with stored bump are used consistently, and every signer seed uses `vault.owner`.
- Owner instructions use `has_one = owner` plus seeds.
- `Deposit` uses seeds only, which still binds to the signer (lib.rs:1051-1075).
- Kamino CPIs pin program, kVault, user = Safe and canonical shares ATA, and check Safe ownership of both token accounts (lib.rs:246-279).
- Exponent and Orca CPIs use fixed account templates. Only the Safe gets signer privilege, and outer signers are not forwarded (exponent.rs:280-310, 343-376; test at exponent.rs:578-582).
- Every Exponent action checks balance deltas end to end: exact `spent`, `acquired ≥ min_output`, no leftover ONyc/YT, SY dust ≤ 32 raw units (exponent.rs:417-420, 470-475).
- The 120 s deadline is enforced (exponent.rs:270).
- Fee math: proportional basis rounds down, so the fee can be over-charged by at most 1 raw unit × fee_bps. That is negligible, and the final exit releases all remaining basis (lib.rs:37-46; tests lib.rs:1428-1453).
- The executor 24h ledger cannot be reset by changing limits (test lib.rs:1464-1477).
- `protect_generic` only inspects classic 165-byte token accounts (exponent.rs:43). That is fine while all protected mints are classic SPL, but it must be revisited if a Token-2022 mint is ever protected.

### If the agent key (`3ayNPp…`) is stolen

Confirmed from code. The attacker can:

1. Move USDC between the Safe and the pinned Kamino kVault, within allocation and limits.
2. Buy or sell PT-ONyc within limits, losing up to about `max_loss_bps` per trade to a sandwich they control (MEDIUM-1).
3. Sweep Safe PDA lamports (MEDIUM-2).

The attacker cannot withdraw tokens anywhere: Exponent exits pay the **owner's** USDC ATA (exponent.rs:186, 490-491). The attacker cannot change settings, use generic CPI, or act on Safes whose owner revoked them.

Response: the admin removes the key with `set_executor_registry`, which stops 1 and 2 on every Safe at once. Owners `set_agent(default)` to also stop 3.

### What a malicious owner-side frontend could get the owner to sign

- Allowlist plus generic CPI in one transaction: SPL `SetAuthority`, `Approve`, `Transfer` or `CloseAccount` on Safe accounts, or a "swap" with the output in the attacker's account (HIGH-1).
- `set_agent` to another registry-approved key, `set_executor_limits` to huge values, `set_allocation` to 100%, `set_exponent_policy(loss = 500)`. All bounded by the agent powers above.
- `withdraw` / `withdraw_spl` (these only reach the owner's own ATA), or `close_safe` with open positions (LOW-1).
- Ordinary wallet drains that have nothing to do with the Safe.

The UI should never send a transaction it didn't build from a reviewed template. Already the rule in `docs/yield-ai-v2-owner-protocol-api.md:180`.

---

## 2. Hackathon fit

Flow: Phantom → Safe → NEAR 1-Click payout → AI plan → one owner signature → agent executes within limits.

### Confirmed facts (code and chain)

1. **A direct SPL transfer into the Safe's USDC ATA counts, and the agent can deploy it.**
   - `kamino_deposit` sizes its cap from the live ATA balance (lib.rs:675-677).
   - `exponent_buy_pt` spends from `safe_usdc.amount` (exponent.rs:401, 416).
   - There is no internal "deposited" ledger to update. `route_principal` only tracks money inside routes.
   - The CCTP design already relies on this (`docs/yield-ai-v2.md:120`).
2. **Agent limits are enforced on-chain.**
   - Per action, rolling 24h and total principal, in USDC (lib.rs:141-184).
   - Per-route allocation of the Safe's basis (lib.rs:186-199, 689-690; exponent.rs:425).
   - Pause with `enabled = false` (lib.rs:163).
   - Defaults are 1,000 / 1,000 / 1,000 USDC (lib.rs:30, 219-228).
3. **"Owner signs the plan once" needs only existing instructions.** In one transaction: `set_allocation([kamino_bps, onyc_bps, 0…])`, `set_executor_limits(...)`, `init_exponent_position(max_loss, slippage)`, plus `set_agent` if the Safe came from `create_safe_for`. The plan's split becomes allocation bps. The agent can't exceed it but chooses timing and size.
4. **The ATA already exists before payout.** Both `create_safe_for` and `initialize_with_limits` create the Safe's USDC ATA (lib.rs:996-1002, 971-973).
5. **The Exponent route is time-limited.** `exponent_buy_pt` fails at or after 2027-01-10 13:00 UTC (exponent.rs:17, 395). There are about 68 days of fixed yield left on 2026-11-03. The route is pinned to one market.
6. **Exponent exits pay the owner's wallet, not the Safe** (exponent.rs:490-491). An agent "rebalance" out of PT moves money out of the Safe, and the owner's USDC ATA must exist.

### Smallest changes, ranked by value

| # | Change | Why | Effort (estimate) | Redeploy / migration |
|---|---|---|---|---|
| 0 | No contract change. Plan transaction = existing instructions (fact 3) with `max_loss_bps ≈ 100` | Makes the flow work today | 0 | No |
| 1 | Ops: upgrade authority + admin to Squads; treasury on a separate wallet | CRITICAL-1 | 1–2 h | No |
| 2 | UI: delete `DEFAULT_ALLOWED_PROGRAMS` and the allowlist writers; show "generic CPI disabled" in the security panel | HIGH-1 exposure | 1–2 h | No |
| 3 | SOL for the NEAR user's rent and fees: a second 1-Click quote that delivers about 0.01 SOL to the owner wallet (NEAR integration code, which judges score), **or** sponsor-paid variants of `set_executor_limits` / `init_exponent_position` | `set_executor_limits` and `init_exponent_position` make the **owner** pay rent (lib.rs:1267-1273, exponent.rs:86-87). A Phantom user funded only through NEAR has no SOL | 1-Click route: about 0.5 day off-chain. Contract variant: about 0.5 day | Contract variant: upgrade, no migration |
| 4 | Generic-CPI deny-list and post-CPI token-account invariants | HIGH-1 | 1–2 days incl. tests | Upgrade, no migration (allowlists are empty) |
| 5 | `close_safe` principal guard; owner-only `refund_excess_lamports` | LOW-1, MEDIUM-2 | 2–3 h | Upgrade, no migration |
| 6 | Plan expiry: `valid_until` on executor limits | One signature shouldn't authorize forever | about 1 day | Upgrade + realloc of existing 466-byte `ExecutorLimits` PDAs (5 on mainnet) |
| 7 | Optional exit destination = Safe ATA for agent PT exits | Lets the agent rebalance PT → Kamino without leaving the Safe | about 1–2 days + fork tests | Upgrade, no migration |

Rows 0–3 fit before 2026-11-14 without touching the program. I would not run rows 4–7 as a mainnet upgrade in hackathon week. Each upgrade so far needed fork tests, an extend and a multi-step upload (`docs/yield-ai-v2-exponent-dynamic-ticks.md`), and no judging points depend on them.

### Open questions (not verified)

- **What does 1-Click do with a Solana PDA recipient?** The 1-Click OpenAPI (`https://1click.chaindefuser.com/docs/v0/openapi.yaml`, fetched 2026-11-03) only says `recipient` must "match `recipientType`" and gives a wallet-style example. It doesn't say whether the solver:
  - (a) sends to `ATA(recipient, mint)` and allows an off-curve owner such as the Safe PDA,
  - (b) rejects off-curve owners, or
  - (c) sends to `recipient` as a token account.

  Passing the **ATA address** as the recipient under (a) would send funds to an ATA owned by a token account, which nobody can sign for, so they would be lost. Test with about $1, Safe PDA as recipient, refund address set, and confirm the balance lands in the existing Safe ATA. Don't demo until that passes.
- Can 1-Click deliver cbBTC (or another BTC variant) straight into the Safe's cbBTC ATA? Relevant to section 4. Not checked.
- Phantom's preview for Safe-PDA balance changes (HIGH-1). Not checked.
- Source-to-binary match for `6d4030d` (see the top of this report). Not checked here.

---

## 3. Jupiter swaps restricted to Exponent

### What already exists (confirmed)

The deployed program already has an agent-callable route that only moves between USDC and one Exponent PT, and it does **not** use Jupiter:

- **Buy:** Safe USDC → pinned Orca ONyc/USDC Whirlpool `7jhh…` → Safe ONyc → Exponent CLMM `XPC1…` wrapper buy-PT → Safe PT (exponent.rs:390-437).
- **Early exit:** PT → CLMM → ONyc → Orca → USDC to the **owner** (exponent.rs:438-497).
- **Redeem after maturity:** Exponent Core `Exponent…` PT-only merge → ONyc → Orca → USDC (action 2, exponent.rs:282-283, 443).

Each of the brief's asks already has an on-chain check:

| Ask | Where it's enforced |
|---|---|
| Mint allowlist | ONyc, PT, SY, YT pinned (exponent.rs:5-16); protected from generic paths (exponent.rs:39-52; lib.rs:467, 490, 511, 542) |
| Output account = the Safe's own ATA | Account templates with Safe roles (exponent.rs:26-35, exponent_accounts.rs) and Anchor ATA constraints (exponent.rs:176-189) |
| End-to-end minimum | `min_intermediate`, `min_output`, plus balance-delta checks (exponent.rs:407, 417-420, 467-475) |
| Per-tx / per-day caps | Shared executor ledger (exponent.rs:426-427, 477-478) |
| Market state | Market, oracle and maturity validated against pinned layouts; Scope NAV fresher than 600 s (exponent.rs:236-267) |

### Can Jupiter do this? No (checked 2026-11-03)

- `lite-api.jup.ag/swap/v1/quote` USDC → PT-ONyc (`HH7F…`), 100 USDC: **`NO_ROUTES_FOUND`**.
- PT-ONyc → USDC, 100 PT: one route through a **Manifest** order book returning **0.075 USDC** for 100 PT.
- Jupiter's token API lists PT-ONyc at about $0.978.

So Jupiter has no buy route and a predatory sell route. An agent that took a Jupiter quote as its slippage reference would have sold PT for about 0.1% of its value. That is the general reason the floor has to come from something other than a quote. Exponent PT liquidity sits in Exponent's own CLMM and orderbook (Exponent v2 docs, [buy wrapper](https://docs.exponent.finance/developer-clmm/typescript/instructions/ix-wrapper-buy-pt), [choosing your SDK](https://v2-docs.exponent.finance/developers/choosing-your-sdk)). Calling Exponent directly is the only realistic option, and the program already does it.

### Maturity (Exponent docs, [post-maturity](https://docs.exponent.finance/developers/learn/post-maturity))

At maturity the SY rate freezes, PT redeems for SY at the frozen rate, YT stops accruing, and **SY appreciation after maturity goes to the Exponent treasury**. PT left unredeemed earns nothing. The program redeems PT-only through Core and uses the frozen rate (`docs/exponent-onyc-mvp.md`). The docs set no redemption deadline. Redemption on mainnet can't be tested before 2027-01-10. The fork test passed.

### What to build next (after 2026-11-14)

1. **Market rollover before 2027-01-10** (needed to keep the product alive). Generate new templates with `client/src/exponentTemplates.ts`, add a second constant set and a second `ExponentPosition` seed (the seed already includes the market: exponent.rs:87), and fork-test. Estimate: 3–5 days + upgrade (+10 KB extend). No migration for existing positions.
2. **Rate-based floor instead of a self-attested quote** (fixes MEDIUM-1). The owner's plan sets `min_fixed_apy_bps`. On buy, require `face × 10_000 ≥ spent × (10_000 + min_fixed_apy_bps × secs_to_maturity / 31_536_000)`. On exit before maturity, keep `check_loss`, but use a default of 100 bps. Then the AI plan's promise ("≥ X% fixed") is enforced on-chain. Estimate: about 1 day. Upgrade + realloc of `ExponentPosition` (288 bytes, 3 accounts on mainnet).
3. **Generalized N-market version** (only if more than about 2 markets are needed). Store per-market data (core vault, market, SY program, mints, maturity, oracle, template hash) in an admin-written `ExponentMarket` PDA that the owner opts into. Keep program IDs and all balance-delta invariants in code, so a bad admin template can only fail, not redirect funds. Estimate: 1.5–2 weeks + fork tests + audit.

Instruction sketch for (3). Same shape as today's `exponent_buy_pt`:

```text
exponent_buy_pt_v2(order: { amount, min_intermediate, min_output, deadline })
  accounts: authority (owner|agent), vault, executor_registry, executor_limits,
            exponent_market (admin PDA, owner-opted in via position.market),
            position [exponent_position, vault, market.core_vault],
            safe_usdc, safe_base, safe_pt, safe_sy, safe_yt (all ATA(vault, mint) from market),
            owner_usdc, core_vault, sy_meta, oracle, token_program
  remaining: [optional pinned base-leg pool accounts] + [CLMM program + template accounts]
  checks:   owner|agent ∧ registry; position.enabled; now < market.maturity; deadline ≤ now+120
            allocation[route(market)] > 0; executor caps (spent); principal_within_target
            implied-APY floor (above); spent == amount; acquired ≥ min_output
            no residual base/YT; SY dust ≤ 32; every signer meta == Safe only
```

If Exponent lists a market whose base asset is USDC itself, the Orca leg goes away. **Not checked:** which current Exponent markets have a USDC-like base. The live market list wasn't accessible without the JavaScript app. Also, the SDK is pinned at 0.9.29 in `web/` and `client/`, while npm's latest `@exponent-labs/exponent-sdk` is 0.9.32 (2026-10-28). Re-verify the templates before any rollover.

---

## 4. Orca Whirlpools for BTC liquidity

### Pools (Orca public API `api.orca.so/v2/solana/pools?token=<mint>`, fetched 2026-11-03 about 21:00 UTC)

Fee APR below = fees ÷ TVL, annualized. It is **gross**: these pools have `protocolFeeRate = 1300`, so about 13% of fees go to Orca and the LP share is about 87%. It is averaged over all TVL, so in-range concentrated liquidity earns more and also takes more impermanent loss (IL).

| Pool | Address | Fee tier | TVL (USD) | Vol 24h | Vol 30d | Fee APR 24h / 7d / 30d |
|---|---|---:|---:|---:|---:|---|
| SOL/cbBTC | `CeaZcx…GQpbN` | 0.16% | 7.28M | 2.17M | 151M | 17% / 34% / 41% |
| cbBTC/USDC | `HxA6SK…msyLM` | 0.04% | 5.08M | 8.97M | 348M | 26% / 36% / 33% |
| cbBTC/FBTC | `7wrbZ3…xFeRcp` | 0.01% | 2.94M | ~0 | 24k | ~0 |
| SOL/WBTC | `B5EwJV…LwPQA` | 0.05% | 1.77M | 4.94M | 135M | 51% / 42% / 46% |
| cbBTC/WBTC | `4v8ufj…M72` | 0.01% | 1.23M | 2.51M | 57.6M | 8% / 9% / 6% |
| USDG/xBTC | `EbGwM4…LwP` | 0.05% | 1.19M | 0.22M | — | 3% / 4% / — |
| cbBTC/JLP | `7XFiNg…ErtmB` | 0.04% | 0.89M | 0.19M | 4.7M | 3% / 2% / 3% |
| cbBTC/xBTC | `CaQLX9…6upd` | 0.01% | 0.24M | 0.03M | 2.3M | 0.5% / 1.4% / 1.2% |
| WBTC/USDC | `55BrDT…cEiy` | 0.05% | 0.12M | 0.22M | 3.1M | 32% / 18% / 16% |
| cbBTC/zBTC | `4z3sxE…GvbuZ` | 0.01% | 23k | 20k | — | 3% / 3% / — |

Total Orca TVL by BTC variant (sum of pools returned):

| Variant | TVL |
|---|---:|
| cbBTC | ~18.3M |
| WBTC | ~3.3M |
| xBTC | ~1.5M |
| zBTC | ~36k |
| tBTC | ~3.6k |
| LBTC | ~0 |

zBTC, tBTC and LBTC are too thin to use. Realistic first candidates:

- **cbBTC/WBTC 0.01%:** two BTC wrappers, so impermanent loss is mostly depeg risk. About 6–9% gross fee APR.
- **cbBTC/USDC 0.04%:** about 33% gross, but fully exposed to BTC/USD impermanent loss and LVR. It needs active range management.

These are snapshots, not forecasts.

### What it takes for the Safe PDA to own a Whirlpool position

Based on Orca's Whirlpool program design. Re-verify against the current IDL before building.

| Step | Mechanics | Who signs | What the Safe must pin |
|---|---|---|---|
| Tick arrays | `initialize_tick_array` / dynamic tick arrays for both range ends | Permissionless, any payer | — |
| Open | `open_position` or `open_position_with_token_extensions`: fresh position-mint keypair, position PDA `["position", mint]`, NFT in `ATA(owner, mint)` | Outer payer + new mint keypair; owner = Safe PDA, no Safe signature needed | NFT ATA owned by the Safe; registry of position mints per Safe |
| Increase | `increase_liquidity(_v2)`: liquidity, token_max_a/b, tick arrays | **Safe PDA** as position authority (invoke_signed) | Source accounts = Safe ATAs; pool in allowlist |
| Decrease | `decrease_liquidity(_v2)`: token_min_a/b | Safe PDA | **Destination accounts must be Safe ATAs.** Orca doesn't require that |
| Collect | `collect_fees`, `collect_reward` | Safe PDA | Same destination pinning |
| Close | `close_position`: liquidity 0, burns the NFT, rent to `receiver` | Safe PDA | receiver = owner |

Owner-only first version through `execute_protocol_cpi`: **technically yes**. Allowlist the Whirlpool program only. Outer signers (payer, position-mint keypair) are forwarded (lib.rs:634), the Safe PDA signs, and `withdraw_spl` can move the position NFT to the owner as an emergency exit. **But it puts Orca in the allowlist, which re-opens HIGH-1:** an owner-signed Orca `swap` or `decrease_liquidity` can send funds to any account. Orca also has position-locking instructions, which could lock a Safe position. **Not checked:** the current lock semantics. It also has no principal or fee accounting and no NAV. Acceptable for a supervised demo with a trusted frontend. Not acceptable as an agent route.

### A proper route (after the hackathon)

New `ROUTE_ORCA_BTC = 2`, with a pinned pool allowlist in code, as the ONyc pool already is (exponent.rs:15, 343-376). Typed instructions:

- `orca_open(pool, tick_lower, tick_upper)`: range width within owner-set bounds around the oracle price.
- `orca_increase` / `orca_decrease` / `orca_collect` / `orca_close`: all token accounts are Safe ATAs, mins required, rent to owner.

On every call:

- Pool price must be within N bps of an oracle (Pyth or Scope BTC/USD). This guards against sandwiching, the LP version of MEDIUM-1.
- USDC value from the oracle, charged to executor limits and allocation.
- Per-Safe position registry PDA, and cost basis for fees.

Who rebalances: the owner first. The agent only after the oracle-band check and a per-day rebalance count limit are in place. Each rebalance locks in impermanent loss.

Effort (estimate):

- Owner-only demo through generic CPI: 2–4 days of SDK and UI work, no contract change.
- Typed owner-only route: about 1 week + fork tests + upgrade.
- Agent-run route with oracle bands: 2–3 weeks + audit.

Main risks: impermanent loss and LVR on cbBTC/USDC; depeg on BTC/BTC pairs; out-of-range idle time; oracle and pool manipulation; CU and transaction size (the existing Orca + Exponent buy uses about 567k CU); Token-2022 position NFTs; Orca program upgrades breaking pinned layouts (already happened once with dynamic tick arrays, see `docs/yield-ai-v2-exponent-dynamic-ticks.md`).

**Verdict:** confirms the earlier plan. Orca BTC LP comes after 2026-11-14 and is not "easy to add" safely. The easy version is the unsafe one.

---

## Sources (fetched 2026-11-03)

- Solana mainnet RPC `api.mainnet-beta.solana.com`: program, ProgramData, config, registry, and the five Safe accounts (slots 465042679–465042724).
- `spl-token` 8.0.0 source (crates.io), `src/processor.rs`.
- [Orca pools API](https://api.orca.so/v2/solana/pools)
- Jupiter `lite-api.jup.ag` quote and tokens APIs.
- [NEAR Intents 1-Click OpenAPI](https://1click.chaindefuser.com/docs/v0/openapi.yaml); [1-Click docs](https://docs.near-intents.org/near-intents/integration/distribution-channels/1click-api)
- Exponent docs: [post-maturity](https://docs.exponent.finance/developers/learn/post-maturity), [buy wrapper](https://docs.exponent.finance/developer-clmm/typescript/instructions/ix-wrapper-buy-pt), [choosing your SDK](https://v2-docs.exponent.finance/developers/choosing-your-sdk); npm `@exponent-labs/exponent-sdk`.
