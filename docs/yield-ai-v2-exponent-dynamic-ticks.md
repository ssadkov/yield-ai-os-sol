# Exponent DynamicTickArray recovery — 2026-10-05



## Confirmed cause and current boundary



The public Exponent 1-USDC investment endpoint returned sanitized HTTP 503. This was **not** an RPC outage: market loading and quoting succeeded, but the unsigned builder rejected the current Orca range. The reviewed static array `4AnnpKm2SYDWHcWyuPp8q73Ge72wRgxXxvrwE8Z722fS` is no longer the active range. At this snapshot the SDK selected `4xddixxbq398nakRXsGbvQtJo7451o1BjzKfftEQBrZD`, a 1716-byte **DynamicTickArray** starting at -67672.



Before this upgrade, the Mainnet Safe accepted canonical fixed TickArrays, not dynamic accounts. Merely changing the builder would fail on-chain with `InvalidAccounts`. Dynamic TickArrays must never be substituted without contract validation. Quote success and balances do not prove execution availability.



## Fix



- Validate both exact Orca layouts, their discriminator, start alignment/bounds, pinned Whirlpool, Orca owner and canonical PDA. Validate the dynamic bitmap, enum tags and bounds before CPI. The three SDK-selected tick accounts are checked individually; no arbitrary pool or mint can be supplied.

- Preserve existing Safe state layouts, instruction tags, owner/executor permissions, limits, recipient checks, slippage and economic floor.

- Gate dynamic account selection on the **exact reviewed candidate ELF hash**. The old reviewed ELF remains recognized for fixed arrays. Unknown ELF remains unavailable.

- Until that candidate is upgraded on-chain, investment/USDC exit plans return **422 `EXPONENT_UPGRADE_REQUIRED`**, with **no signing payload**. Position/market reads continue to return balances and `marketInfo.executionReady: false`, `unavailableCode: EXPONENT_UPGRADE_REQUIRED`.

- `EXPONENT_ROUTE_UNAVAILABLE` (422) denotes unsupported/missing/malformed tick accounts. RPC failures retain sanitized 503. Mobile clients should keep viewing positions but disable signing when no ready plan exists; never bypass these errors.



The candidate is an upgrade of program `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`, not a new Safe program. Existing Safes, owners and positions keep their addresses. There is no new user signature schema or migration.



## Reviewed artifacts and evidence



Historical source base: `codex/exponent-fixed-income`, commit `4a42267`. It is the deployed Exponent source lineage, separate from the main branch's older Rust source. The narrow contract fix must be reviewed against this base; do not deploy the older Rust source from main.



| ELF | Bytes | SHA-256 |

| --- | ---: | --- |

| Pre-upgrade Mainnet fixed-only | 686960 | `9543eb14e69694d25d6a4d1bba2a5bcc7f00f1d34a095112d0b898764805269f` |

| Installed dynamic support | 690944 | `48da204eea62b79db16474045a2ede6e139c54e4d1023f99b09dfc3adfe7565d` |



Build: WSL Ubuntu, Anchor 0.32.1, Solana 3.1.12, Cargo release opt-level `s`, historical locked dependencies. Candidate ELF lives locally in `/tmp/onyc-dynamic-build-20261005/target/deploy/yield_vault.so`. IDL/instruction schemas are unchanged.



Verification:



- 15 Rust tests passed, including fixed/dynamic and malformed bitmap/layout rejection.

- 56 mobile tests passed, including canonical PDA, wrong owner/pool/discriminator, changed static range, malformed dynamic bitmap/tags/length and old-ELF dynamic refusal.

- API TypeScript and Production build passed.

- Actual upstream ELF LiteSVM fork, fresh Mainnet snapshot **slot 453493605**, **2026-10-05T06:07:08.470Z**: USDC -> PT -> half exit -> remaining exit passed for 100, 1000 and 10000 USDC. Full immediate round-trip proceeds were 99.873512, 998.735135 and 9987.351637 USDC respectively: fees/spread are real in the fork, these are not profit claims. Each buy/sell packet was 1026 bytes.

- Fifteen negative fork cases passed, including dynamic-array foreign pool, wrong discriminator and noncanonical start supplied directly to the contract (bypassing the builder), executor action/daily/principal caps, pause, foreign signer, stale quote, market/recipient substitution, slippage and atomic rollback.

- Native ONyc flow and maturity frozen-rate checks passed. Maturity uses a synthetic clock/feed in the local fork; it is **not live maturity acceptance**.

- Local Mainnet API probe returned 422 / `EXPONENT_UPGRADE_REQUIRED`; position read returned 200 with existing PT balances and explicit unavailable state. No Mainnet transaction was signed or sent.



Reproduce: use `client/src/exponentForkPrepare.ts` for public account fixtures (10-account batches; larger PublicNode batches were blocked), then the candidate ELF, matching IDL and `client/src/v2ExponentFork.ts` under Linux LiteSVM. `EXPONENT_READ_RPC` is optional for a local private read RPC; never commit or upload it. Full snapshot and report are local at `/tmp/onyc-dynamic-fork-20261005`.



## Mainnet upgrade budget — read-only estimate



Deployer and upgrade authority: `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`.

ProgramData recipient: `GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY`.



At slot 453494117: deployer **3.660720821 SOL**, ProgramData 687005 bytes / 3.490635640 SOL.



- Candidate ELF requires 3984 extra bytes, but unsigned Mainnet loader simulation rejects extensions below **10240 bytes**. The successful unsigned simulation (2520 CU, fee 5000 lamports) extends ProgramData to **697245 bytes**, minimum rent **3.542654840 SOL**. No simulation changes chain state.

- Permanent rent increment: **0.052019200 SOL**.

- Temporary upload buffer: 690981 bytes; rent **3.510833720 SOL**, refunded on successful upgrade/close.

- Network fees are additional. Use a **0.01 SOL fee cap** and recheck balances/rent immediately before submission; total permanent debit cap **0.062019200 SOL**, peak rent-plus-fee requirement **3.572852920 SOL**. The quoted balance is sufficient.



**No upgrade is authorized by these tests or this document.** Obtain separate Mainnet approval with the exact artifact, payer/program/rent recipients and fee cap. After upgrade verify actual ProgramData hash, authority and rent; then probe 1-USDC invest plus partial/full exit unsigned plans. Funded owner/MWA entry/exit and interruption recovery remain the live acceptance gate. Preserve the previous ELF for rollback; do not rotate authority or touch USDC in the upgrade.



## Published API recovery state



API PR #30 (main), contract PR #31 (historical deployed source lineage). Public Mainnet Production `dpl_7VNySwuvkXjek7wtABk1AE4rtQPx`, runtime SHA `17e693e57ed81fbda13ca7c886d0d740480247d0`, **READY**. Public 1-USDC Exponent investment and all-PT exit both return 422 / `EXPONENT_UPGRADE_REQUIRED` without payload; position returns 200 with `533605536` raw PT and explicit blocked state. Mainnet and Devnet config endpoints each return 200 for their own pinned cluster/program; Mainnet Kamino APY returns 200 / available. This repairs diagnosis and fail-closed state; it does not claim the contract upgrade is complete.



Upgrade preparation additionally passed a combined **unsigned Mainnet simulation**: extend ProgramData 10240 bytes, create a seeded upload buffer and initialize its authority (5040 CU, 5000-lamport network fee). Seed `yield-onyc-dyn-20261005`, base/authority = deployer, owner = BPFLoaderUpgradeable, derived buffer **`HhQJ1ecMoG5fa5xXgjRQyaxxmxsJtzLj3jxfPUVf8NAK`**. This requires no new private key. Account absence was checked before simulation; stop and reconcile if it already exists on a later run. It is only a proposed recipient: **the buffer has not been created**, ProgramData has not been extended and the deployer balance has not changed. The final upgrade itself must be simulated after the approved buffer upload, then its on-chain ELF checked.



Rollback artifact `/tmp/onyc-final.so` was rehashed and matches the existing fixed-only reviewed SHA-256. Candidate ELF and IDL are also saved under the contract worktree's ignored `target/deploy` and `target/idl`, respectively. No private key or RPC secret is included in these artifacts.


## Authorized upgrade execution

The owner explicitly approved the Mainnet upgrade in chat on 2026-10-05, after the exact program/artifact, recipients, temporary/permanent rent and 0.01-SOL total network fee cap were shown.

Preparation confirmed: `4XWxVG6MbwgFQjEuHxKuHr8ZKgMq59j619SDzMuPSYhbLx2S5kbcKrJYvhQHbgykRk3jSLWPKbWQyk696ee2NAt4`; ProgramData extended 10240 bytes and the proposed seeded buffer created, fee 5000 lamports. Program code is unchanged until final upgrade.

`client/src/exponentUpgradeMainnet.ts` pins Mainnet genesis, payer, program/ProgramData/buffer, old/candidate ELF hashes, authorities, rent and a 10,000,000-lamport fee cap. It reads the existing local operator signer; it never creates or persists a private key. Local journal `/tmp/onyc-dynamic-upgrade-20261005.json` saves signatures, signed bytes and blockhash expiry before broadcast, reconciles uncertain signatures, and resumes only byte ranges different from the approved ELF.

PublicNode produced inconsistent block-height/blockhash data during preparation; the unsigned/signed pre-broadcast guard stopped and no transaction landed. Actual preparation/upload uses the already authorized **local Helius env**; no private RPC URL was transferred to Vercel. A few unlanded upload signatures expired and were reconciled before resuming. Upload uses 900-byte writes with a 25,000-CU limit and 20,000 micro-lamports/CU (500-lamport priority fee, 5500 total per packet), within the unchanged total fee cap. Retransmission always uses identical signed bytes until expiry; confirmed ranges are never deliberately rewritten.

Stages: `inspect`, `prepare`, `upload`, `simulate-upgrade`, `upgrade`, `verify`. Signing stages require `EXPONENT_UPGRADE_APPROVED_SHA256` equal to the reviewed hash and `EXPONENT_DEPLOYER_KEYPAIR` pointing to the existing operator. Optional local-only settings: `EXPONENT_UPGRADE_RPC_URL`, `EXPONENT_UPGRADE_ELF`, `EXPONENT_UPGRADE_JOURNAL`. All writes are to the reviewed loader accounts; no USDC/Safe/protocol operation is constructed. Final verify checks candidate hash, retained authority, buffer closure, permanent rent increment, actual payer debit and network fee cap.

## Finalized Mainnet result — 2026-10-05

Upgrade **finalized**, slot **453510076**, error null:
[4VcAVvujJXqwJ13wnJU6YHpwEWGHQhahvFrSmcw8DnfeBJQ3Gu7PppVjhXkigfssZzsxxwdcsfgvQWLgQMjKzJg4](https://solscan.io/tx/4VcAVvujJXqwJ13wnJU6YHpwEWGHQhahvFrSmcw8DnfeBJQ3Gu7PppVjhXkigfssZzsxxwdcsfgvQWLgQMjKzJg4).

- Installed ELF SHA-256 exactly `48da204eea62b79db16474045a2ede6e139c54e4d1023f99b09dfc3adfe7565d`, 690944 bytes. ProgramData remains at the same address, 697245 bytes, 3.542654840 SOL rent.
- Program address, existing Safes/positions and upgrade authority are unchanged.
- Seeded buffer is closed. Its full **3.510833720 SOL** was returned to deployer in the upgrade receipt (buffer pre-balance 3510833720, post-balance 0).
- Final upgrade itself: **5000 lamports / 0.000005 SOL**. Entire confirmed preparation/upload/upgrade planned-fee sum: **0.004202 SOL**, below the 0.01-SOL cap.
- Deployer before **3.660720821 SOL**, after **3.604499622 SOL**. Actual net decrease **0.056221199 SOL**; permanent rent increment **0.052019200 SOL**. Net non-rent debit is 0.004201999 SOL (one lamport lower than the confirmed planned-fee sum); do not equate a whole-wallet delta with a receipt fee. Both are below the cap.

Public stable Mainnet API now reports `deploymentVersion: dynamic_ticks`, `executionReady: true`, reason null. Unsigned public plans all returned **200 / ready**, with no signing or sending of user funds:

| Request | Simulation slot | CU | Network fee | Minimum output |
| --- | ---: | ---: | ---: | --- |
| Wallet -> Exponent, 1 USDC | 453510460 | 566578 | 19000 lamports | 1027986839 raw PT |
| Exponent -> wallet, 50% PT | 453510467 | 428318 | 19000 lamports | 256628 raw USDC |
| Exponent -> wallet, all tracked PT | 453510474 | 428106 | 19000 lamports | 513257 raw USDC |
| Wallet -> Kamino, 1 USDC | 453510478 | 161650 | 5000 lamports | — |

Existing pilot position still has **533605536 raw PT**. These quotes are snapshot examples, expire normally, and are not future proceeds guarantees. Devnet config separately returned 200 with its original program `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5`; it was not upgraded.

On-chain operations in this release were **only loader preparation, upload and upgrade**. No user USDC/PT was transferred. Funded owner API/MWA entry, exit and interruption recovery remain the integration acceptance gate. RPC keys remained local, no Vercel secret was changed, and PR merge is separate from this completed program upgrade.

## PR #32 integration check — 2026-10-05

The original `yield-ai-os-sol` Preview deployments `dpl_EM5nh5P9QTtjr5W5VzQqYLy9UgFY` (PR #31) and `dpl_EoVSVgMwBAd9Rnm4DNx4WsywRBBA` (PR #32) failed TypeScript validation: `exponentOrca.ts` imports `exponentV2.ts`, while the historical contract branch lacked `allowImportingTsExtensions`. This was a web build failure; it did not undo the finalized Mainnet program upgrade.

PR #29 and PR #30 were merged into `main`. PR #31 was merged into `codex/exponent-fixed-income`, not directly into `main`. PR #32 brings that contract/source/UI history into `main`. The PR branch was synchronized with `main`, keeping the current mobile planners, wallet-funded Exponent transactions, Config discriminator validation, simulation slots, dependency lockfile and Vercel tracing limits. Existing Rust error variants retain their order; the two variants from `main` follow them. This source merge is not another program deployment and is not a claim that the merged source reproduces the installed ELF.

The legacy `/api/earn-ideas` route now resolves live RPC data at request time instead of during static generation. Without this change, a local build repeatedly received public RPC HTTP 429 responses and retried page generation.

Public endpoints checked separately from the failing Preview:

- Devnet: `https://yield-ai-solana-devnet.vercel.app/api/mobile/v1/config` returned HTTP 200. Scope: Solana Safe creation, atomic creation plus first deposit, wallet-to-Safe deposit, idle USDC withdrawal and transaction status. No Kamino or Exponent execution on this deployment.
- Mainnet: `https://yield-ai-solana-mainnet.vercel.app/api/mobile/v1/config` returned HTTP 200. Kamino yield returned `available`. Exponent position reported `dynamic_ticks`, `executionReady: true`.
- Unsigned Mainnet plans for pilot owner `EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2`: 1 USDC Kamino wallet deposit `ready` (159087 CU); 1 USDC Exponent wallet investment `ready` (567178 CU); 50% PT withdrawal `ready` (428441 CU). These probes did not sign or send transactions.
- All 56 mobile tests passed and all 15 Rust host tests passed after resolving the source conflicts.

Vlad can integrate against the two public base URLs and the documents on `main`: `docs/yield-ai-v2-solana-safe-api.md` and `docs/yield-ai-v2-owner-protocol-api.md`. The remaining mobile acceptance check is a funded wallet/MWA entry and exit, including timeout/status recovery. Unsigned simulation readiness is not that funded acceptance result.

The integrated PR #32 Production build (`npm run build` in `web`) passed after the above fixes, including TypeScript validation and static generation.
