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
3. MWA signs. Wallets may insert reviewed Lighthouse assertions and bounded ComputeBudget instructions; the requested Safe/ATA instructions, their account permissions, owner and amounts must remain unchanged. Compare decompiled instructions rather than requiring whole-message byte equality. Persist the final wallet-returned signed bytes/signature/owner/cluster/target/expiry **before** sending. The transport checks permitted operation families, not equality against a stored plan; the client must check its requested operation.
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

## Kamino yield for the mobile strategy card

`GET /api/mobile/v1/protocols/kamino/yield?cluster=mainnet` is public and requires no owner or existing Safe. `/config` advertises `capabilities.kaminoYield` and `kaminoYieldEndpoint`. Devnet cannot serve Mainnet yield as testnet yield.

The current pinned route is **Kamino Private Credit USDC**, vault `91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy`. It is the same vault used by the typed owner deposit/withdrawal API.

- `apyRatio`: decimal string from Kamino's published `apy`, e.g. `"0.07487914368164117"`.
- `apyPercent`: exact percentage string, e.g. `"7.487914368164117"`; round to two decimals for display, do not multiply this field again.
- `historicalApyRatio`: published `24h`, `7d`, `30d`, `90d`, `180d`, `365d` ratios. Missing/invalid optional values are `null`, never zero.
- `rateType: variable`, `guaranteed: false`: published indicative/trailing metrics, not a guaranteed future rate or the user's realized PnL.
- `source` and `sourceField`: fixed official Kamino metrics URL and `apy`. See [official APY documentation](https://kamino.com/docs/build/earn/get-vault-apys).
- `fetchedAt`, `expiresAt`: Unix milliseconds, at most 60 seconds of server cache. `sourceUpdatedAt: null`: Kamino does not provide a metrics generation timestamp here; retrieval time must not be represented as that timestamp.
- `feeScope: kamino_published`, `yieldAiPerformanceFeeIncluded: false`, `networkFeeIncluded: false`: not a net Yield AI/user return. Safe performance fee is charged separately on positive realized profit.

Invalid required APY, timeout or failed upstream refresh returns HTTP 503 / `YIELD_UNAVAILABLE`; expired cached rates are not served as fresh. Show unavailable/last known with a visible timestamp in the app, not 0% or a silently retained rate. Wrong/unknown request fields return 400. The endpoint never signs, builds or submits a transaction.

**Creation default remains idle:** new Safe allocation is `[0,0,0,0,0,0,0,0]`. Creating or funding Safe does not auto-invest into Kamino. Manual Kamino deposit temporarily sets the required target and restores the owner's allocation in the same transaction.

Verification: four yield tests (decimal/percent units, missing/corrupt/negative/zero metrics, 60-second cache and refresh failures, malformed/oversized responses); 51 total mobile tests. Official source snapshot on 2026-10-05: APY ~7.49%, seven-day APY ~7.64%; examples, never hardcode them.

Published APY addition: commit `2540b681b2fc838e4c92bb8af067d954623e2a71`, Production deployment `dpl_5zEtqwE2hxxfbwhepyenVdeAAV6n`, READY with stable alias assigned. Public unauthenticated yield probe returned `available`, `apyPercent: "7.487914368164117"` and the pinned vault; public config advertises the yield endpoint. All 51 mobile tests, TypeScript and local Production build passed. No on-chain transaction or program upgrade was performed. PR #29 was merged into main on 2026-10-05.


## Exponent availability update — 2026-10-05

The Orca active price range moved to DynamicTickArray, which the previous fixed-only Safe ELF rejected. That incident was resolved by a **finalized Mainnet upgrade at slot 453510076**. Installed ELF SHA-256 `48da204eea62b79db16474045a2ede6e139c54e4d1023f99b09dfc3adfe7565d` (690944 bytes). Program address, owner/executor permissions, existing Safe/position schemas and instruction tags are unchanged. No migration is needed.

The public API detects `deploymentVersion: dynamic_ticks` and `marketInfo.executionReady: true`. Wallet investment of 1 USDC, 50% PT exit and all-PT exit each returned 200 / ready with successful unsigned Mainnet simulations. Each Exponent plan quoted 19000-lamport network fee in this snapshot; request a fresh plan before signing. Kamino 1-USDC deposit also returned ready; Devnet remains independent and unchanged.

The old reviewed fixed-only ELF is still recognized for fixed arrays. Dynamic arrays require the exact new on-chain ELF. Each selected Orca account is checked against the pinned pool, canonical PDA, owner and ABI. Unsupported or malformed routes return 422 without a signing payload; never bypass the availability guard. See [cause, tests, finalized transaction and costs](yield-ai-v2-exponent-dynamic-ticks.md).

The upgrade used SOL only. Public probes did not sign/send USDC or PT transactions; funded owner/MWA entry/exit and interruption recovery remain to be accepted in the mobile application.

## Public Exponent yield before wallet connection

GET `/api/mobile/v1/protocols/exponent/yield?cluster=mainnet`

This read-only endpoint quotes the reviewed PT-ONyc market for exactly **100 USDC** with `action=buy`, `asset=USDC`, `slippageBps=50` and **no owner or authority**. No Safe, prepared position, token balance, wallet connection or signature is required. It returns no transaction and cannot move funds. Only `cluster=mainnet` is accepted; owner, arbitrary amounts, markets, duplicate cluster values and other query parameters are rejected.

| Field | Meaning |
|---|---|
| `status` | `available` for a fresh validated quote |
| `referenceAmountUsdc` | Decimal string `100`; this is the quoted reference amount |
| `apyRatio` / `apyPercent` | Exact `maturityPreview.netApyAfterCurrentDexAndFutureProfitFee` from the buy quote; percent = ratio × 100 |
| `aprRatio` / `aprPercent` | Simple annualized net return, distinct from compounded APY |
| `maturity` | ISO timestamp `2027-01-10T13:00:00.000Z` |
| `fetchedAt` / `expiresAt` | Unix **milliseconds**; refresh by expiry. Cache maximum 60 seconds, shortened to the quote/oracle deadline |
| `chainTimeUnixSeconds` | Chain clock in **seconds**, explicitly named |
| `quoteId` / `slot` | Reference quote identity and chain snapshot |
| `projectedNetUsdc` | Decimal USDC proceeds for the 100-USDC reference at maturity using today's NAV/DEX |
| `projectedFutureProfitFeeUsdc` | Future display policy: 5% of positive projected profit only |
| `pilotProfitFeeBps` / `displayProfitFeeBps` | Current Exponent pilot charges 0; displayed future profit fee policy is 500 bps |
| `indicative` / `guaranteed` | `true` / `false`; this is a quote-based maturity scenario |
| `networkFeeIncluded` / `rentIncluded` | Both false |

APR = (projected net proceeds / 100 USDC − 1) × 31,536,000 / seconds until maturity. APY is the existing compounded quote calculation; do not relabel an APY value as APR. The Kamino yield endpoint returns APY, so the Flexible card must say APY when displaying `apyPercent`.

The reference includes current entry/estimated maturity-exit DEX economics and projected future profit fee. PT maturity payoff and the future **USDC** conversion are different: future ONyc NAV and DEX liquidity/fees are unknown. A card may display `aprPercent` as “estimated APR until maturity” or `apyPercent` as “estimated APY”; the amount-specific invest quote remains the pre-signing source of truth. Do not describe the reference USDC proceeds as guaranteed. For “If you deposit” on 1k/10k, multiplying the 100-USDC preview is only an estimate and does not include size-dependent price impact; refresh an actual invest plan before signing.

Fresh requests share an in-flight quote/cache within each function instance. Expired results are never returned after an upstream failure. HTTP 503 returns the standard error envelope with `error.code=YIELD_UNAVAILABLE` and `error.details={status:"unavailable",apyRatio:null,aprRatio:null}`; no private RPC URL or raw SDK exception is exposed. Missing/unsupported query values are HTTP 400. Devnet has no reviewed Exponent market and does not expose an execution route; querying this endpoint on a Devnet deployment is rejected.

`/config` advertises `capabilities.exponentYield` and `capabilities.exponentYieldEndpoint`. No program upgrade or on-chain transaction is needed to add the endpoint.

Verification of the ownerless yield addition (2026-10-05): all 62 mobile tests passed; the existing app Vercel Preview build succeeded. Dedicated Mainnet API Preview `dpl_14EAtb2hGMuqM2P89S8qqcAj36YX` returned HTTP 200, `Cache-Control: no-store`, `status=available` without any owner. At fetchedAt `1791208851979`, reference 100 USDC produced APR `11.446320247816978327951630327736760115313680667053` percent, APY `11.93604798176184764` percent, and projected net proceeds `103.040574` USDC. These are an expiring snapshot, not a static promised rate. Foreign owner/duplicate cluster/wrong cluster probes returned HTTP 400. Production release of reviewed code SHA `ad3ce0e888fb95122f4007bd16c23681483684a6` is READY in deployment `dpl_Hf9YTvsmdgXnwxZXHXKwzeX3Ca1L`. The stable public Mainnet URL returned HTTP 200 / available at fetchedAt `1791209090156`; config advertises the endpoint and keeps transaction submission enabled. Kamino yield remained available and the core owner deposit plan returned ready after unsigned simulation. Both Vercel builds completed with TypeScript validation. PR #33 carries the source and documentation.

## Owner Exponent allocation compatibility (2026-10-07)

A newly created mobile Safe has `allocationBps: [0,0,0,0,0,0,0,0]`. The deployed contract requires ONyc route slot 1 to be nonzero even for an owner-signed PT buy. A prepared Exponent position is insufficient: the previous buy plan for Seed Vault owner `CFgqVALQxKws6HtbCA4QjVDwaterCFNZzNyK3V8zV4Ls`, Safe `EaTtmyFyvgGu7WFbsXbgw27NkDTbWALNNYoTaqjB93UD`, failed unsigned Mainnet simulation with `RouteDisabled` / custom error 6011. This is separate from `/rpc` rejecting wallet-added Lighthouse instructions. A working public yield quote does not prove that a particular owner's investment plan is executable.

The corrected owner buy builder temporarily sets allocation to `[0,10000,0,0,0,0,0,0]` only when slot 1 is disabled, includes the optional wallet-to-Safe deposit and PT buy, then restores the exact original allocation in the same atomic transaction. The wallet signs once. A failure rolls back every instruction. The response adds `allocationBpsAfter`, the original policy; selecting Fixed never leaves an executor route enabled. Already enabled owner buys and all exits do not add allocation instructions. Executor-signed buys never receive owner allocation overrides and remain subject to the deployed route and volume checks. No program upgrade or additional API request field is required.

Production RPC was changed by the operator to Helius Mainnet and redeployed as `dpl_wM1HwE4c1TNDqXnuFjFSpZoCJ5mp` / source `ad3ce0e888fb95122f4007bd16c23681483684a6`. That deployment contains the old owner-plan builder; changing RPC does not publish the allocation fix. Readiness, simulation and transport acceptance must be verified separately. RPC credentials remain server-only.

### Helius read budget and unsigned acceptance

The unpaced Helius Free client reproduced HTTP 429 on `getAccountInfo`; generic RPC exceptions were exposed as the existing sanitized `503 SERVICE_UNAVAILABLE`. On the dedicated Mainnet mobile API, Helius read requests now share a per-function-instance start budget of 5 requests/sec. Only `get*` and `simulateTransaction` requests retry HTTP 429, at most twice, honoring Retry-After up to the bounded request budget. Long cooldowns, network failures and other status codes are returned without automatic retry. This fetch layer never retries `sendTransaction`; mandatory preflight and existing submission policy are unchanged. The budget is per instance, not a distributed quota: concurrent Vercel instances share the Helius account limits, so this is pilot handling rather than a production-wide quota guarantee.

Local patched **unsigned Mainnet** simulations with the configured Helius provider succeeded for a 1-USDC wallet-funded buy:

| Owner | Result | CU | Packet bytes | Network fee | Allocation after |
| --- | --- | ---: | ---: | ---: | --- |
| `CFgqVALQxKws6HtbCA4QjVDwaterCFNZzNyK3V8zV4Ls` | ready / no simulation error | 569944 | 1141 | 19000 lamports | all zero; temporary enable and restore included |
| `EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2` | ready / no simulation error | 569770 | 1083 | 19000 lamports | `[5000,5000,0,0,0,0,0,0]`; no override needed |

No transaction was signed or broadcast. These results do not prove a funded mobile deposit. Wallet-added Lighthouse compatibility is a separate transport issue and is not changed by this patch. A wallet-modified packet must still fit the 1232-byte limit; the bytes above are before wallet augmentation. Production must deploy this reviewed patch before the mobile app can use the corrected owner plan.

## Phantom / Solflare wallet guards (2026-10-07)

The mobile `/rpc` transport now accepts the wallet augmentation reported on Seeker: Lighthouse `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` **discriminator 6 (`AssertAccountInfoMulti`) only**, with one target account. It may occur anywhere, repeatedly, within the unchanged 1232-byte packet limit. Both reported data prefixes `06 04` and `06 05` are supported; the assertion body is decoded by mandatory RPC preflight. This is intentionally narrower than permitting every Lighthouse command: memory write/close and all other unreviewed discriminators remain `400 INVALID_TRANSACTION`. Account flags are global in Solana messages, so a guard reading the writable owner/Safe is not rejected just because decompilation shows writable/signer flags.

Source review: the [generated instruction SDK](https://github.com/Jac0xb/lighthouse/blob/main/clients/js/src/generated/instructions/assertAccountInfoMulti.ts) pins discriminator 6 and a single target; the [processor](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/processor/assert_target_account.rs) and [account-info evaluation](https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/types/assert/account_info.rs) only inspect state. Unsigned Mainnet probes against the deployed program confirmed both log variants and rejected a false assertion with custom error 6400. No signature or broadcast was performed.

ComputeBudget instructions may appear before or after Safe instructions. Supported variants are heap frame, compute-unit limit, compute-unit price and loaded-account data limit; their data lengths and bounds are checked. Price is capped at **500000 micro-lamports/CU**. This admits the reported Phantom 375000 and Solflare 100000 values. With the 1400000 CU ceiling, priority fee cannot exceed 700000 lamports (0.0007 SOL), plus base fee and any account rent. The plan's cost is the original unsigned estimate; if the wallet changes its budget, its final fee can differ. This patch does not add automatic priority-price selection to Seed Vault plans.

Envelope validation still requires v0, one owner signature/payer, at most four active LUTs, a reviewed Safe operation and no unrelated top-level programs. The owner signature is now verified locally; each Safe authority must equal that payer. Safe/ATA instructions are never rewritten by the transport. Existing on-chain account/mint/recipient validation stays authoritative. The transport has no stored plan/planId comparison; it does not claim to compare signed Safe/ATA bytes or a re-signed blockhash with a server-side original plan. Clients must continue checking the unsigned plan before asking the wallet to sign.

`/rpc` invokes `sendRawTransaction` once with `skipPreflight:false`, `preflightCommitment:confirmed`, `maxRetries:2`. An explicit RPC error response before acceptance is sanitized as HTTP 422 / `SIMULATION_FAILED`; transport validation stays HTTP 400 / `INVALID_TRANSACTION`. Unknown network/provider failures remain 503: they can occur after submission, so query signature status before re-signing. Error envelope shape is unchanged and private provider URLs/logs are never returned.

Unsigned Mainnet create-and-deposit **0.5 USDC** simulations for owner `CK2uPRmqnZSC4txzhu9upPpEDETiJfPg2axhU3Fx9YcK`, prospective Safe `J62yL3Wb3UrdTSME35TSpN6LppzFYtuhxegJLy542XM8`:

| Fixture | Simulation | CU | Packet bytes |
| --- | --- | ---: | ---: |
| Original Seed Vault plan | success | 62378 | 593 |
| Phantom-style: two guards, 375000 price | success | 64479 | 657 |
| Solflare-style: trailing price 100000 and `06 05` guard | success | 63506 | 647 |

These are synthetic wallet augmentations of a real unsigned API plan, not captured wallet payloads or funded Seeker acceptance. After release, Vlad should repeat setup and Flexible deposit/withdraw with Phantom and Solflare on the same app build, then check Seed Vault. If a wallet emits another Lighthouse discriminator/account shape, retain the rejection and capture the full expired plan/signed payload for review. No contract upgrade or mobile request-format change is needed. The dedicated Mainnet API project must deploy the merged fix; deploying only the web UI project does not update this host.

Local verification: all 85 mobile tests passed, including 14 new broadcast compatibility/security tests. The previous transport test now uses a real local test signature instead of fabricated nonzero signature bytes.
TypeScript no-emit validation and diff whitespace check also passed.

### Priority-fee ceiling correction (2026-10-07)

A subsequent Seeker deposit was rejected by our transport with `Compute unit price exceeds transport limit`. This is the backend's 500000 micro-lamports/CU ceiling from the first wallet-guard patch, not an on-chain program failure. The screenshot alone does not provide the wallet's actual CU price/limit, and its displayed network cost includes rent; it cannot establish the final wallet-modified fee. The rejection occurs before upstream submission.

The corrected policy limits **total priority fee to 1000000 lamports (0.001 SOL)**, rather than limiting price per CU. Calculate `ceil(priceMicroLamports * requestedCuLimit / 1000000)` using BigInt, after reviewing all budget instructions regardless of position. The existing CU-limit ceiling stays 1400000; without an explicit limit, use that conservative upper bound. Duplicate budget variants are rejected, consistent with the runtime, so a later low price/limit cannot mask an earlier expensive value. The cap excludes the base fee and rent. Example: 3000000 micro-lamports/CU at 300000 CU costs 900000 lamports (0.0009 SOL) and is now permitted, despite exceeding the previous per-CU ceiling.

Over-budget responses retain HTTP 400 / `INVALID_TRANSACTION` and include safe decimal-string diagnostics in `error.details`: `priorityFeeLamports`, `maxPriorityFeeLamports`, `computeUnitPriceMicroLamports`, `computeUnitLimit`, and `conservativeLimit`. No signed bytes, private RPC URLs or credentials are returned. Signature, owner/payer, Safe/ATA, Lighthouse discriminator 6, packet size and mandatory-preflight checks remain in place. No transaction is rewritten after the wallet signs. Mobile request shape and the contract are unchanged.

Primary reference: [Solana compute budget and fee constraints](https://solana.com/docs/core/fees/compute-budget). Acceptance still requires the rejected wallet's actual price/limit or expired payload, and then a funded Seeker retry after the corrected API is released. Do not claim the pictured transaction has been accepted based on synthetic regression tests alone.
Verification: all 89 mobile tests passed, including high-price/low-total acceptance, exact ceiling round-up, conservative missing-limit handling, u64 extremes and duplicate-budget rejection.


## Lighthouse assertion families: 2026-10-08

This supersedes the discriminator-6-only policy above. Phantom's reported wallet `4qMokYU7riMKgtG7zf4S22oFimcooAfPXySSc4XWMgkE` can create its Safe, but a token-moving Kamino deposit adds other assertion families and the old transport rejects it before submission. This is an API transport change; no contract upgrade, new mobile API URL or request-format change is needed.

### Reviewed policy

The exact Lighthouse program remains `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`. Source reviewed at [Jac0xb/lighthouse commit 4c57947](https://github.com/Jac0xb/lighthouse/blob/4c579479c98635e419b1b167f08be02a71604a71/programs/lighthouse/src/instruction.rs), including assertion processors, evaluation macros, program validation and CPI targets. All currently defined assertion discriminators **2 through 17** are accepted anywhere/repeatedly within the packet limit:

| Tags | Assertions | Account shape |
| --- | --- | --- |
| 2, 3 | Account data, single/multi | 1 target |
| 4 | Account delta | 2 targets |
| 5, 6 | Account info, single/multi | 1 target |
| 7, 8 | Mint, single/multi | 1 target |
| 9, 10 | Token account, single/multi | 1 target |
| 11, 12 | Stake, single/multi | 1 target |
| 13, 14 | Upgradeable loader, single/multi | 1 target |
| 15 | Sysvar clock | No accounts |
| 16 | Merkle tree | Tree, root, pinned compression program, optional proof accounts |
| 17 | Bubblegum tree config | 1 target |

MemoryWrite **0**, MemoryClose **1**, every unknown discriminator and malformed account shapes remain `400 INVALID_TRANSACTION`. Merkle verification calls only the fixed verify-leaf instruction of `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK` with read-only accounts; that program is pinned both upstream and in our transport. Assertion logging may use fixed SPL Noop with no accounts. Mint evaluation borrows data mutably in upstream Rust, but the reviewed macro only reads values. These assertion paths do not transfer funds or create/close accounts.

Full assertion payload decoding and success/failure remain enforced by mandatory RPC preflight. A malformed/false assertion is not bypassed or removed. Wallet-returned signed bytes are submitted unchanged. Existing signature, owner/payer, Safe operation allowlist, ATA, v0, LUT and packet checks remain; the PR #36 **0.001 SOL total priority-fee cap** also remains. Assertion account flags may appear writable/signer due to Solana's message-global permissions.

### Evidence and limits

- 94 deterministic API tests pass, including all 16 assertion families, every rejected byte discriminator, token/mint guards with deposit/withdraw operation families, active LUTs, malformed account shapes, foreign Merkle program, mandatory preflight and unchanged-wire submission. Fixtures exercise transport validation; they do not claim every assertion body is valid on chain.
- Reproducible unsigned probe: `web/scripts/mobile-lighthouse-probe.mjs`, using server-only `V2_MAINNET_RPC_URL`. It requests a fresh wallet-source 1 USDC Kamino plan and only calls simulateTransaction with zero signatures.
- Reported Phantom owner, Safe `BuUfTrud6jrK1CHSreiBE2Cjh6KsQVCe5r5YpLcNMnai`: actual Mainnet plan with synthetic AssertTokenAccount (9), AssertMintAccount (7), AssertTokenAccountMulti (10) passed at slot **454560517**, **185442 CU**, **837 bytes**. Final wallet USDC balance was asserted against the 1 USDC debit.
- Increasing that asserted final balance by one raw unit failed at slot **454560518**, Lighthouse custom **6401**, proving the post-transfer check is still evaluated.
- No transaction was signed or broadcast. These probes use synthetic guards, not the original Phantom-returned packet. Funded Seeker acceptance is still required after deployment.

### Release and Vlad's acceptance

At verification time the dedicated Mainnet API host still serves PR #35 (commit `30ef1f3`); merged PR #36 is not yet released there. Release the reviewed merged commit of this fix to **yield-ai-solana-mainnet**, which includes both fixes. An app/UI Preview or GitHub merge alone does not update the manually released API host.

On the existing mobile build and same API URL, obtain a **fresh deposit plan** for the already-created Safe (skip setup), sign a 1 USDC Kamino deposit with Phantom, then test partial/full return. Repeat token-moving entry/exit with Solflare; smoke-test Seed Vault. Verify wallet/Safe/share balances and explorer receipt. For errors before broadcast show **Not submitted**, not Not signed or Solana rejected: the backend already checked a valid wallet signature. Reconcile any ambiguous previous send before requesting another transfer. If rejected again, capture error details plus the final decoded instruction tags, budget and packet length (never seed/private keys).
