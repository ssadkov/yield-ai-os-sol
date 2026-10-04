# Yield AI v2 — Mainnet mobile Safe release candidate

Date: 2026-10-04. Branch: `codex/yield-ai-v2-mobile-mainnet`, based on `origin/main` (`b2ed575`). This is the first release slice: native Solana owner → idle USDC Safe → owner. Kamino API, EVM owners, CCTP, Exponent and autonomous executor workers are separate releases.

## Hosts and integration

- **Mainnet Preview:** deployment URL will be recorded after READY. API base is that origin + `/api/mobile/v1`; test page `/v2/mobile`. Vercel SSO remains enabled: this is an operator Preview, not yet a public mobile API origin.
- **Public Devnet:** `https://yield-ai-solana-devnet.vercel.app/api/mobile/v1`; existing Seeker test page `/v2/devnet`. Its code/deployment is unchanged by this release.
- **Production:** `https://yield-ai-os-sol.vercel.app` is the intended Mainnet origin after acceptance and an explicitly authorized Production release. Do not point the mobile app there until `/api/mobile/v1/config` returns the accepted release. A merge alone is not proof that the correct environment and wallet cycle are deployed.
- [API request/response contract](yield-ai-v2-solana-safe-api.md).

For Vlad: keep one API origin per build/environment and read `/config` before signing. Mainnet expects `cluster: mainnet`, `chain: solana:mainnet`, program `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`, USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. Never infer the chain from an EVM wallet network or hostname. The private provider URL stays server-side; no Vercel token, agent key or RPC credential belongs in the app.

## Delivered cycle

1. `GET /config`, `GET /safes?ownerType=solana&address=OWNER&cluster=mainnet`.
2. `POST /safes/creation-plan` with optional `initialDepositUsdc: "1"`: new Safe + canonical USDC ATA + executor policy + first deposit, atomically, one owner signature. Existing Safe returns `already_exists` with no transaction or repeat deposit.
3. `POST /deposits/plan`, `amount: "1"`: wallet → Safe.
4. `POST /withdrawals/plan`, `amount: "0.4"` or `"all"`: **idle USDC only**, to the same owner's canonical ATA.
5. `GET /transactions/SIGNATURE?cluster=mainnet&lastValidBlockHeight=HEIGHT`: reconciliation including historical receipts.

USDC is represented by exact decimal strings, not floating-point values. The owner signs and pays rent/network fees. No gas sponsorship. Default allocation is all idle; default executor comes from the admin registry. Creation enables separate action / rolling 24h volume / principal limits of 1000 USDC. Owner limits are enforced on executor movements, not on ordinary owner deposits/withdrawals. The browser checker pins the reviewed default executor `3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH`; changing the default requires reviewing/updating the checker.

## Signing and recovery

`mobileSafeWallet.ts` rebuilds every instruction before signing: fixed genesis/program/mint, owner/payer, Safe/registry/limits PDAs, canonical token accounts, exact requested amount, idle allocation, one signer, no lookup tables, no additional instructions, and unsigned packet <=1232 bytes. It uses a dedicated `yield_vault_mobile.json` native ABI snapshot, ported from the tested integration branch (`174ee98`), without replacing the older UI IDL or redeploying the program.

`/v2/mobile` gets its network from the checked API config, checks blockhash expiry, verifies the wallet did not change the reviewed message and persists signed bytes/signature before RPC submission. Pending operations are separated by owner and cluster. An account switch cancels stale UI work; uncertain submission blocks a fresh transfer until reconciliation. This panel is a reference implementation, not physical Seeker/MWA acceptance or cross-device idempotency.

Optional `POST /rpc` is a restricted RPC transport (`getGenesisHash`, `getBlockHeight`, gated `sendTransaction`), not a signer or durable transaction job. Preflight is mandatory; retransmission uses identical signed bytes. For native MWA, retain the signed transaction and signature locally **before** sending, and use a trusted RPC or resolve `/config.rpcTransport` against the API origin. The API does not choose a new transfer after a timeout.

`unknown_or_expired` means history is inconclusive. Reconcile receipt, balances and a reliable historical RPC before requesting another plan. No `Idempotency-Key`, portfolio NAV, protocol exit job, APR/history or agent `why` is promised in this slice.

## Deployment configuration

Preview uses only branch-scoped env in the existing `yield-ai-os-sol` Vercel project; Production settings are not changed. Helius URL transfer to `V2_MAINNET_RPC_URL` was explicitly authorized for this Preview on 2026-10-04.

```dotenv
V2_MOBILE_CLUSTER=mainnet
V2_MAINNET_RPC_URL=<private server-only Helius URL>
V2_MOBILE_MAINNET_SEND_ENABLED=0
NEXT_PUBLIC_V2_PROGRAM_ID=yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih
NEXT_PUBLIC_RPC_URL=https://api.mainnet-beta.solana.com
NEXT_PUBLIC_V2_LAB_ENABLED=0
AUTHORITY_SECRET_KEY=
CRON_SECRET=
SUPANODE_TOKEN=
```

Mainnet send is opt-in. `0` still permits reads and unsigned simulations, but disables the sign/send button and the mobile RPC send method. It is not an on-chain pause: the owner can independently send their signed transaction via their own RPC. Public release additionally requires ingress rate limits and a public origin suitable for native clients; protected Preview SSO is not mobile API authentication. Browser cross-origin CORS is not opened; native HTTP does not need CORS.

The old `NEXT_PUBLIC_PROGRAM_ID` no longer overrides the v2 IDL: this fixes the observed Production-build failure with a stale legacy program ID. Explicit mismatched `NEXT_PUBLIC_V2_PROGRAM_ID` still fails closed. No Rust/IDL redeployment or live Mainnet transaction occurred in this change.

## Verification, 2026-10-04

- 25 deterministic/security tests passed, including Mainnet/Devnet separation, recipient/mint/amount/extra-instruction/signature substitution, missing ATA, repeated creation, insufficient balances, revoked executor and rejected simulation.
- Next.js 16.2.1 production build and its TypeScript check passed with deliberately stale legacy `NEXT_PUBLIC_PROGRAM_ID`. Local dependency junction initially failed Turbopack; installing the existing lockfile into this worktree resolved it. No dependency upgrade or lockfile churn.
- Local production HTTP probe reached live Mainnet through server-side Helius: correct genesis and executable program; approved registry/default executor; existing pilot Safe; unsigned create/deposit/partial/all-idle simulations; wrong-cluster/recipient/amount refusals; gated RPC submission and rejected RPC methods; existing historical receipts finalized; `/v2/mobile` rendered HTTP 200.
- Snapshot: Safe `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ`, idle `0.998997` USDC, owner wallet `11.602327` USDC. These are a dated snapshot, not NAV or a reservation.
- Creation simulation: 55,315 CU; rent 8,595,360 lamports + fee 5,000 = **0.008600360 SOL**. Deposit: 14,713 CU; idle withdrawal: 14,868 CU; fee **0.000005 SOL** each where ATAs already exist, zero priority fee. Account presence and fee conditions can change costs.
- **Zero signed/sent transactions.** These Mainnet simulations do not replace a funded wallet/MWA acceptance cycle. New Mainnet atomic creation+first-deposit is covered by deterministic tests; the live Mainnet create simulation here was empty creation. Devnet atomic creation+deposit was already finalized in the previous release.

From `web`, Node 24:

```sh
npm ci --ignore-scripts
npm run test:mobile-safe
npm run build
# Start local server on 3304 with the private Mainnet RPC and send flag 0.
npm run probe:mobile-mainnet
```

## Release gates and extension order

1. READY protected Mainnet Preview + review the plans. Keep wallet sending disabled until the agreed pilot.
2. Vlad accepts the native Devnet cycle on physical Seeker: create+first deposit, repeat deposit, partial/all withdrawal, interruption/restart, wrong chain and insufficient SOL.
3. Separately approve the small Mainnet wallet cycle, enable sending only for the pilot, verify finalized receipts and balances. For an existing funded Safe, `all` also includes pre-existing idle funds: do not silently withdraw unrelated balances as part of a small pilot.
4. Prepare an authorized public Production release with explicit Mainnet config and no server signing credentials. Verify the client-facing deployment and mainnet wallet cycle before broader onboarding.
5. Integrate reviewed Kamino API PR #26 and its resumable owner withdrawal. Kamino exit may need several reserve legs and a separate owner return transaction. Prove a funded API entry/exit before enabling it for the mobile app.
6. Add autonomous executor budgets/journal, strategy/APR, portfolio/history/activity and agent `why` as additive capabilities. EVM owner/EIP-712, CCTP and Exponent retain separate acceptance gates.

Existing native Solana Safes remain usable without recreation for compatible protocol extensions. New position accounts can be derived alongside the existing Safe. Layout changes require explicit migration; upgrading the program alone does not make migrations automatic. Future EVM-owned Safes use a different owner mode/PDA and do not convert an existing Solana-owned Safe. Load capacity is not established by this pilot.
