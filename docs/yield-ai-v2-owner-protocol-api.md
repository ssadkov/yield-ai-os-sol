# Yield AI v2: public Mainnet owner protocol API

Date: 2026-10-05. Branch `codex/yield-ai-v2-mobile-mainnet`. [PR #29](https://github.com/ssadkov/yield-ai-os-sol/pull/29).

## Hosts for Vlad

- Mainnet API base: **https://yield-ai-solana-mainnet.vercel.app/api/mobile/v1**. Dedicated Production project; Vercel SSO and password protection disabled. Production is **READY** and public endpoint probes pass (details below).
- Devnet API base: **https://yield-ai-solana-devnet.vercel.app/api/mobile/v1**. Core Safe / idle USDC cycle only.
- [Core request contract](yield-ai-v2-solana-safe-api.md), [release notes](yield-ai-v2-mobile-mainnet.md).

Read `GET /config` before signing. Mainnet expects `cluster: mainnet`, program `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`, genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. Only native Solana owners are supported here. Server holds no signer. Executor workers, EVM ownership and bridges are separate integrations.

Native MWA/Seeker requests have no browser Origin and need no CORS grant. Browser/WebView origins require an exact match in server `V2_MOBILE_ALLOWED_ORIGINS` (comma-separated). Supply the app's actual origin to enable its web build. No bearer credential or private RPC URL belongs in the app.

## Common owner request

```json
{"owner":{"type":"solana","address":"YOUR_SOLANA_WALLET"},"cluster":"mainnet"}
```

Every plan returns **unsigned v0 transaction(s)** under `steps[].transaction` (base64), required owner signer, simulation, rent/network fee in lamports, blockhash and `lastValidBlockHeight`. Sign only `status: ready`. Empty, setup-required, unavailable and failed-simulation responses must not trigger a signature. Each issued step has one owner signature. The owner pays SOL; there is no sponsor.

Core endpoints retain their contract: `POST /safes/creation-plan` with optional `initialDepositUsdc` creates Safe + first deposit atomically; `/deposits/plan` funds idle Safe; `/withdrawals/plan` returns idle USDC, partial decimal `amount` or `all`. Existing Safe creation returns `already_exists` without repeating the deposit.

## Kamino owner cycle

Fixed reviewed USDC vault: `91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy`.

| Operation | Endpoint | Fields beyond owner/cluster |
| --- | --- | --- |
| Read position | `GET /protocols/kamino/position` | query `ownerType=solana&address=OWNER&cluster=mainnet` |
| Invest | `POST /protocols/kamino/deposits/plan` | `source: wallet` or `safe`, decimal USDC `amount: "1"` |
| Redeem shares | `POST /protocols/kamino/withdrawals/plan` | `phase: redeem`, either `percent: "50"` or `shares: "RAW_INTEGER"` / `"all"` |
| Return redeemed USDC | same withdrawal endpoint | `phase: return`, `redemptionSignature: "CONFIRMED_SIGNATURE"` |

Minimum entry: 1 USDC. Both wallet -> Safe -> Kamino and idle Safe -> Kamino are atomic, one signature. The temporary target needed by the contract is restored to the original allocation in the same transaction. Upstream setup/farm/arbitrary instructions are rejected.

Redemption returns USDC to Safe. It can need multiple reserve legs; each plan issues only the current checked leg, with `targetSharesRaw`, `legSharesRaw`, `remainingTargetSharesRaw`. Persist the initial raw target. After confirmation use actual `burnedSharesRaw` from the receipt-return response to subtract from the outstanding target. Continue with explicit remaining raw shares, **never repeat a percentage** against a reduced balance.

For each redemption, `phase: return` verifies success, typed Safe instruction, sole owner signer and pre/post token balances, then transfers the actual net Safe USDC increase to the same owner's canonical wallet ATA. Partial exits preserve existing idle funds. Full supported exit ends with an idle `amount: all` withdrawal after all target shares are redeemed. Cap automatic reserve attempts at eight; if liquidity or simulation prevents completion, show the remaining position.

Persist each redemption and return signature, signed bytes and expiry before submission. Return planning is not a durable single-use receipt service: signing a newly planned return after it already succeeded could consume other idle funds. Reconcile the stored return signature after a timeout. If the journal was lost, inspect transaction history before replanning. A rejected wallet return leaves redeemed USDC in Safe for an ordinary idle withdrawal.

Kamino's configured positive-profit performance fee is separate from network fees (current policy 5%). Receipt return uses actual net proceeds, not an estimate or 5% of principal.

## Exponent owner cycle

Market `onyc-10jan27`, maturity **2027-01-10 13:00 UTC**. Entry: USDC -> ONyc -> PT. Exit: PT -> ONyc -> USDC **directly to the owner's canonical wallet ATA**, in one transaction.

| Operation | Endpoint | Fields beyond owner/cluster |
| --- | --- | --- |
| Read market/position | `GET /protocols/exponent/position` | query `ownerType=solana&address=OWNER&cluster=mainnet` |
| Prepare ATAs and position | `POST /protocols/exponent/deposits/plan` | `phase: setup`, optional `slippageBps: 50` |
| Invest | same deposit endpoint | `phase: invest`, `source: wallet` or `safe`, decimal USDC `amount: "1"`, optional `slippageBps: 50` |
| Exit | `POST /protocols/exponent/withdrawals/plan` | either `percent: "50"` or `shares: "RAW_PT_INTEGER"` / `"all"`, optional `slippageBps: 50` |

Setup is separate and quotes rent for missing ATAs and the position. Confirm setup before requesting a fresh investment. No position -> `setup_required`, no payload. After setup, wallet -> Safe -> PT is atomic with one signature. PT uses **9 decimals**, while USDC uses 6: `shares` is always raw PT, not a UI USDC amount.

Chain clock selects sale before maturity, redemption at/after maturity. Default slippage 50 bps, supported request range 2..100. Show `minimumOutputRaw` and enforce `quoteExpiresAtUnixSeconds` as well as blockhash expiry. Pilot performance fee is **zero**. Indicative APY and maturity proceeds use current NAV/DEX assumptions; they are not guaranteed fixed USDC proceeds or future exit liquidity.

Execution requires the exact reviewed Mainnet ELF SHA-256 `9543eb14e69694d25d6a4d1bba2a5bcc7f00f1d34a095112d0b898764805269f`, fixed Exponent accounts and reviewed Orca tick array. Changed ELF, stale Scope oracle, unsupported tick range, insufficient liquidity, expired quote or simulation failure yields no ready payload. Maturity redemption has fork evidence; live settlement cannot be proven before maturity. No contract upgrade is included in this API release.

## Sign, send, reconcile

1. Decode the unsigned packet. Verify v0, <=1232 bytes, one connected-owner signer/payer, pinned chain/program, exact amounts/deadlines and canonical accounts. Resolve LUTs from a trusted Mainnet RPC and inspect all instructions.
2. `mobileSafeWallet.ts` is the strict **core** checker and deliberately rejects protocol plans. Protocol validation uses `web/src/idl/yield_vault_protocols.json`, the reviewed Kamino validators and `web/src/lib/exponent-onyc-10jan27.json`. Do not allow arbitrary extra instructions to make the core checker accept them.
3. MWA signs; returned message must equal the requested message. Persist signed bytes/signature/owner/cluster/target/expiry **before** sending.
4. Send through a trusted RPC or API `POST /rpc`: JSON-RPC `sendTransaction`, params `["BASE64_SIGNED_TX",{"encoding":"base64"}]`. Mandatory preflight; only reviewed Safe operation families are accepted. This transport has no private signer and is not a job queue.
5. Use `GET /transactions/SIGNATURE?cluster=mainnet&lastValidBlockHeight=HEIGHT`. After a timeout retransmit only identical signed bytes while valid; never request a fresh transfer before reconciliation. Refresh portfolio state after confirmation.

## Public deployment and evidence

New Vercel project: `yield-ai-solana-mainnet`, id `prj_tQiZKhw25G02iz76wgTBlLxdcQbp`. Public project exposes mobile API routes and the existing `/v2/mobile` **core** reference panel; legacy cron/agent/bridge routes return 404. The current RPC is public PublicNode, with **no key**; the local private Helius URL was not copied to this project. Git was disconnected after creation: releases deploy a reviewed SHA manually. Existing app and Devnet host remain independent.

- 47 deterministic tests pass: core owner cycle, Kamino substitution/partial/full/receipt-return checks, PT selection, reviewed Exponent SDK layouts, public route isolation and exact CORS origins.
- TypeScript and Production build pass.
- Live read-only snapshot: pilot Safe `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ` has 0 Kamino shares, `533605536` raw tracked PT, zero ONyc/YT and 12 raw SY dust. Exact ELF gate true.
- Unsigned Mainnet simulations: wallet -> Kamino 1 USDC, 161697 CU, fee 5000 lamports, no rent; wallet -> Exponent 1 USDC and 50% PT exit each 521558 CU, fee 19000 lamports, no rent. These are independent simulations on existing balances, **not newly sent funded round trips**.
- Full PT exit also simulates successfully: `533605536` raw PT, 418350 CU, fee 19000 lamports, minimum wallet proceeds `513075` raw USDC (0.513075 USDC), no rent. Setup on the already prepared pilot also returns ready, rent zero. Wrong cluster and authority override return 400; a foreign browser Origin returns 403.
- Owner-signed funded API exits, network interruption recovery and physical Seeker UX remain integration acceptance. Earlier UI transactions do not prove the new API journal behavior. No Mainnet transaction was signed/sent by the agent in this release.
- Production `dpl_F3L8xoqcDhEJawdoX3q31RFfsUyi`, source SHA `e81ce756302e12195532611782baf482e6b3c7ba`, target `production`, state `READY`, stable alias assigned. SSO/password protection are null; project has no Git link, no signer and no private RPC key.
- Public unauthenticated probes: `/config` 200 with pinned Mainnet genesis/program; Kamino wallet deposit 1 USDC 200/ready (161801 CU, fee 5000 lamports); Exponent wallet buy 1 USDC 200/ready (450753 CU, fee 19000 lamports); Exponent all-PT exit 200/ready (418336 CU, fee 19000 lamports, minimum 513073 raw USDC). Zero-shares Kamino exit returns `redeemed`, no steps. Legacy agent/cron/RPC routes return 404.
- The first public build used the official shared Solana RPC: config and Kamino worked, Exponent returned sanitized 503. Switching to public PublicNode passed both protocol probes without transferring a secret. Private Helius is an optional later configuration that still requires destination-specific consent.
- Fixed Vercel bundling limit by restricting forced Jupiter runtime tracing to Jupiter/agent routes and excluding source maps/declaration files. Traced sizes: legacy Kamino 76.56 MB (was 270.21 MB), Exponent deposit 40.36 MB, mobile Kamino withdrawal 22.37 MB. Final Vercel Production and existing app Preview builds pass. These HTTP checks only simulate unsigned plans; no user funds were sent.
