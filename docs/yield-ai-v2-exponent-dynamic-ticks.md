# Exponent DynamicTickArray recovery — 2026-10-05

## Confirmed cause and current boundary

The public Exponent 1-USDC investment endpoint returned sanitized HTTP 503. This was **not** an RPC outage: market loading and quoting succeeded, but the unsigned builder rejected the current Orca range. The reviewed static array `4AnnpKm2SYDWHcWyuPp8q73Ge72wRgxXxvrwE8Z722fS` is no longer the active range. At this snapshot the SDK selected `4xddixxbq398nakRXsGbvQtJo7451o1BjzKfftEQBrZD`, a 1716-byte **DynamicTickArray** starting at -67672.

The existing Mainnet Safe accepts canonical fixed TickArrays, not dynamic accounts. Merely changing the builder would fail on-chain with `InvalidAccounts`. Dynamic TickArrays must never be substituted without contract validation. Quote success and balances do not prove execution availability.

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
| Current Mainnet fixed-only | 686960 | `9543eb14e69694d25d6a4d1bba2a5bcc7f00f1d34a095112d0b898764805269f` |
| Candidate dynamic support | 690944 | `48da204eea62b79db16474045a2ede6e139c54e4d1023f99b09dfc3adfe7565d` |

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
