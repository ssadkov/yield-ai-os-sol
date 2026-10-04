# Yield AI v2: Solana wallet Safe API v1 — idle USDC cycle

Mainnet release candidate, 2026-10-04: [Mainnet pilot, release gates and integration](yield-ai-v2-mobile-mainnet.md). This branch selectively ports the native API onto `origin/main`; new endpoints use an isolated `yield_vault_mobile.json` IDL. No contract upgrade is required.

Devnet update, 2026-10-03: [Seeker integration, hosts and live round trip](https://github.com/ssadkov/yield-ai-os-sol/blob/codex/yield-ai-v2-cctp-mainnet/docs/yield-ai-v2-seeker-devnet.md). Optional first deposit is supported atomically with creation; read-only transaction status is available. Public Devnet API base: `https://yield-ai-solana-devnet.vercel.app/api/mobile/v1`; [test panel](https://yield-ai-solana-devnet.vercel.app/v2/devnet). Dedicated staging deployment is READY, with Vercel login/password protection disabled by owner approval. Mainnet Production is a separate environment; do not use it for this pilot.

Date: 2026-09-30. Scope: read/create a personal Safe, deposit wallet USDC into it, and withdraw idle USDC back to the owner. Each action returns one unsigned transaction. The existing Solana contract ABI is retained. Protocol investments, allocation changes, portfolio NAV, agent history and EVM relay remain outside this API slice.

## Deployment and trust boundary

Release branch: `codex/yield-ai-v2-mobile-mainnet`, based on `origin/main` (`b2ed575`). The executor policy is already deployed on Mainnet; the API uses its native ABI without changing or redeploying the Rust program. The existing public Devnet deployment remains a separate release. Kamino API PR #26 and EVM relay are outside this slice.

The server chooses one cluster with `V2_MOBILE_CLUSTER=devnet|mainnet` (default `devnet`). The caller must explicitly repeat that cluster. Private RPC variables: `V2_DEVNET_RPC_URL` for Devnet; `V2_MAINNET_RPC_URL` for Mainnet, with existing server-only Supanode header support. No program, mint, executor, signing key or arbitrary instruction is accepted from the caller. Do not put RPC credentials or server credentials in the mobile bundle.

| Cluster | Program | USDC mint |
| --- | --- | --- |
| Devnet | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Mainnet | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

Read and unsigned-plan endpoints are public. Only an actual owner signature on the Solana transaction changes chain state. Rate limits belong at the deployment ingress before opening this API broadly. Native mobile HTTP calls do not require browser CORS. Separate web origins will need an explicit CORS policy.

## API contract

Base URL: the deployment origin, followed by `/api/mobile/v1`. JSON responses have `Cache-Control: no-store`. USDC amounts are decimal strings with six digits; costs and SOL balances are integer lamport strings; times are unix milliseconds. Network/program/mint are explicit in every state response.

For the Seeker Devnet pilot use **`https://yield-ai-solana-devnet.vercel.app/api/mobile/v1`**. Example first read: `GET https://yield-ai-solana-devnet.vercel.app/api/mobile/v1/config`. Native clients do not need a Vercel account/token. Requests to this host must use `cluster: devnet`; Mainnet requests fail with `CLUSTER_MISMATCH`.

### GET /config

Returns `version`, `network` (`cluster`, `chain`, `genesis`, `programId`, `usdcMint`), `supportedOwnerTypes: ["solana"]`, wallet signing/submission, and capabilities. Safe creation, wallet deposits and idle USDC withdrawals are implemented; `allocation` and `evmOwner` are false. Public Mainnet now advertises `protocolDeposits: true`, `protocolWithdrawals: true` and explicit Kamino/Exponent routes; idle `/withdrawals/plan` retains `idle_usdc` scope. Devnet supports only the core idle cycle. Capability flags describe implemented endpoint features; each plan still checks live state and simulates. Added fields: `sponsoredGas: false`, `transactionSubmissionEnabled` and `rpcTransport: "/api/mobile/v1/rpc"`. Mainnet wallet submission is opt-in via server `V2_MOBILE_MAINNET_SEND_ENABLED=1`; default is disabled. Native clients can send signed bytes via their own trusted RPC after acceptance, or resolve this relative transport path against the API origin. This gate controls the test page/transport, not the on-chain owner authority.

### GET /safes?ownerType=solana&address=OWNER&cluster=mainnet

Returns canonical `safe`, `usdcAta`, `ownerUsdcAta`, `executorLimitsAddress`, existence flags, wallet SOL, `walletUsdc`, **idle** Safe USDC, allocation, route principal, assigned executor, its current approval, current default executor, and on-chain executor limits. `idleUsdc` is not total portfolio NAV and excludes Kamino shares and other assets; `routePrincipalUsdc` is cost basis, not NAV. An existing legacy Safe can have `executorLimits: null`; reading it does not migrate or reset it.

Owner addresses must be canonical on-curve Solana wallet addresses. The API validates the RPC genesis, executable program loader, account owners/discriminators, Safe owner/PDA bump, registry, limits binding and USDC ATA mint/authority/state. It fails closed on malformed or substituted accounts.

### POST /safes/creation-plan

Request:

```json
{
  "cluster": "mainnet",
  "owner": { "type": "solana", "address": "YOUR_SOLANA_WALLET" }
}
```

Body limit: 2048 bytes. Unknown fields are rejected. EVM owners return `UNSUPPORTED_OWNER_TYPE` for now.

`status: "ready"` returns:

- `planId`: SHA-256 of network genesis + unsigned transaction bytes; an identifier, not a stored job.
- `state`: pre-creation state and canonical addresses.
- `cost`: missing account rent, network fee, total, current wallet SOL, fee payer, priority fee (currently zero).
- `defaults`: current admin-approved executor; limits enabled with `1000.000000` USDC each for action, rolling volume and principal; allocation `[0,0,0,0,0,0,0,0]`.
- `steps`: one `create_safe` setup step with unsigned version-0 transaction as base64 and the owner as the sole required signer.
- `blockhash`, `lastValidBlockHeight`: transaction lifetime. Block height is authoritative; there is no fabricated wall-clock expiry.
- `simulation`: successful unsigned simulation slot and consumed CU; `createdAt` in ms.

The transaction contains a 200,000-CU limit and `initialize_with_limits`. It creates the Safe, its canonical USDC ATA and executor policy atomically. Allocation starts entirely idle. Optional `initialDepositUsdc` is a positive decimal string (six decimals maximum): the same transaction appends a typed `deposit` from the owner's canonical USDC ATA. It still needs only one owner signature, returns `initialDepositUsdc`, `initialDepositRaw`, `source`, `destination`, `atomic: true`, and has setup step ID `create_safe_and_deposit`. If omitted, no transfer is included. No protocol deposit or arbitrary CPI is included. ATA rent is omitted if a valid ATA already exists; pre-funded empty System-owned PDAs need only the rent top-up. An orphan existing executor policy is rejected rather than reset.

If the Safe already exists, returns `status: "already_exists"`, current `state`, `steps: []`, including when `initialDepositUsdc` was supplied: no repeat deposit is constructed. Use `/deposits/plan` for another deposit. Do not ask the wallet to sign. Repeating a plan request does not create anything: uniqueness is enforced by the owner PDA on chain. No durable server plan store or `Idempotency-Key` replay guarantee is implemented yet; fresh requests may have different blockhashes/plan IDs. That requirement is deferred to the signed-submission/job layer.

### GET /transactions/SIGNATURE?cluster=devnet&lastValidBlockHeight=HEIGHT

Read-only status lookup with `searchTransactionHistory: true`. Accepts a canonical 64-byte base58 signature and an optional safe-integer block height. Returns network, signature, `status`, `confirmationStatus`, slot, error, finalized blockHeight, blockhashExpired and updatedAt. Statuses: pending, processed, confirmed, finalized, failed, unknown_or_expired. Missing history after blockhash expiry sets `reconciliationRequired: true`: absence alone is not proof that funds never moved. Keep signed bytes/signature before send; reconcile receipt and balances before preparing a fresh transfer. Only finalized success or finalized failure is terminal for automatic client recovery. This is not a transaction submission endpoint or durable job.

Insufficient owner SOL returns HTTP 422 `INSUFFICIENT_SOL` with `error.details.cost`, network and Safe, so mobile can show the exact funding requirement. Estimated rent and fee are a snapshot, not a reservation. Wallet-added priority fees change the final cost.

### POST /deposits/plan

```json
{
  "cluster": "mainnet",
  "owner": { "type": "solana", "address": "YOUR_SOLANA_WALLET" },
  "amount": "2.000000"
}
```

The Safe must already exist and its creation must be confirmed. The API constructs `deposit` using the owner's canonical USDC ATA as source and the Safe's canonical USDC ATA as destination. If the Safe ATA was closed, its idempotent recreation is included in the same transaction and rent is quoted. Owner signs and pays SOL. This moves USDC into the Safe; it does not invest into Kamino or set allocation.

### POST /withdrawals/plan

Same request, with `amount` as a positive decimal USDC string or `"all"`. `all` means **all idle USDC at plan time**, not all assets held in protocol positions. It becomes an exact u64 amount in the signed transaction. New deposits after planning are not included; if the executor moves funds before execution, the transaction may fail and state must be refreshed.

The destination is always the same owner's canonical USDC ATA. There is no `recipient` field: attempts to override it are rejected. Missing owner ATA is created atomically with withdrawal, paid by the owner. No protocol redemption is performed. An empty `all` request returns `status: "empty"`, `scope: "idle_usdc"`, current state and `steps: []`.

The Safe stays open after withdrawal; this endpoint does not close its accounts or refund their rent. `walletUsdc` and the deposit source refer to the owner's canonical ATA, not a sum across arbitrary secondary USDC token accounts.

Ready deposit/withdraw plans share the creation-plan fields (`planId`, `state`, `cost`, `blockhash`, `lastValidBlockHeight`, `simulation`, `steps`, `createdAt`) and also return:

- `scope: "idle_usdc"`, `amount` (six decimal digits), `amountRaw` (u64 integer string).
- `source`, `destination` (canonical token account addresses).
- `allIdleAtPlanTime` (true only for `withdraw` with `amount: "all"`).

Amounts are parsed with integer arithmetic: positive strings only, at most six decimal places, no exponents/signs/whitespace/leading zeroes, and no u64 overflow. Numeric JSON values are rejected. `all` is not valid for deposits. Source token mint/authority/state, available USDC, required SOL and unsigned simulation are checked before returning a payload. Missing Safe returns `SAFE_NOT_CREATED` (409); insufficient source USDC returns `INSUFFICIENT_USDC` (422).

### Default allocation

The contract accepts an eight-route allocation at initialization and an owner-signed `set_allocation` later (sum <= 10000 basis points). It is not permanently fixed. This API deliberately initializes zero allocation so new deposits stay idle during the first wallet/Safe cycle. Product defaults such as Kamino 50% can later be included in the owner's creation transaction once the investment flow is enabled. Existing allocation is not changed by these deposit/withdraw plans.

## Mobile flow

1. Connect Seeker/Seed Vault, Phantom, Solflare, Backpack or another supported Solana signer via the existing mobile wallet bridge.
2. Read `/config`; require the displayed network and actual wallet transaction network to match.
3. Read `/safes`. If it exists, continue to the Safe view. If absent, request the creation plan.
4. Show network, Safe, executor/limits, rent and fee. Before signing, deserialize the transaction and check the displayed owner is the sole signer/fee payer, the program and addresses match config, and the instructions are the expected creation operation. Use Solana transaction signing, not `signMessage`.
5. Ask the wallet to sign and send once. Alternatively use its `signTransaction` then submit through the application's trusted Solana transport. This API version does not provide a generic broadcaster or hold a server key.
6. Keep the signature and `lastValidBlockHeight`. Confirm it through the wallet/RPC, then refresh `/safes` until the initialized Safe appears. On timeout first check signature status and state: do not blindly sign again. A missing signature alone does not prove failure.
7. On expired blockhash, request a fresh plan. If another device has already created the Safe, the fresh response is `already_exists`. For an on-chain failed creation, present the failure and rebuild only after refreshing state.
8. Request `/deposits/plan` with a decimal amount, show the exact source/destination/fee, sign/send the single step through the wallet, confirm its signature, then refresh wallet and Safe balances.
9. Request `/withdrawals/plan` with an amount or `all`, sign/send the single step, confirm and refresh both balances. This completes the wallet -> idle Safe -> wallet USDC cycle.

Deposits are not idempotent across differently signed transactions. Persist the signature locally. After a timeout, check the original transaction status before requesting/signing a fresh plan; use block height to determine expiry. Do not infer completion solely from a balance change, which could come from another operation. Rebuilding an unsigned payload does not itself transfer funds.

Signing/submission rejection or timeout is handled locally by the wallet flow; there is no backend withdrawal job or persisted portfolio record to fabricate. Transaction status and a plan-bound signed-submission endpoint are subsequent API slices.

Example requests (replace host and owner):

```sh
curl "$BASE/api/mobile/v1/config"
curl "$BASE/api/mobile/v1/safes?ownerType=solana&address=$OWNER&cluster=mainnet"
curl -X POST "$BASE/api/mobile/v1/safes/creation-plan" \
  -H 'Content-Type: application/json' \
  --data '{"cluster":"mainnet","owner":{"type":"solana","address":"YOUR_SOLANA_WALLET"}}'
```

Error envelope: `{"error":{"code":"CODE","message":"...","details":{}}}` (`details` optional). RPC URLs/keys and raw provider exceptions are never returned.

| Code | HTTP | Client action |
| --- | --- | --- |
| INVALID_REQUEST / INVALID_OWNER / UNSUPPORTED_OWNER_TYPE | 400 | Fix input; do not sign |
| CLUSTER_MISMATCH | 400 | Reload config and select the correct network |
| INSUFFICIENT_SOL | 422 | Show funding cost; request a fresh plan after funding |
| INVALID_AMOUNT | 400 | Use a positive decimal string with <= 6 decimal places; all only for withdrawal |
| SAFE_NOT_CREATED | 409 | Complete and confirm creation first |
| INSUFFICIENT_USDC | 422 | Refresh the source balance; protocol assets are outside idle withdrawal |
| SIMULATION_FAILED | 422 | Refresh state; no transaction is returned |
| RPC_CLUSTER_MISMATCH / PROGRAM_UNAVAILABLE / INVALID_ACCOUNT | 503 | Stop signing; operator investigates configuration/state |
| EXECUTOR_UNAVAILABLE | 503 | Admin must initialize/unpause the approved default |
| BLOCKHASH_UNAVAILABLE / SERVICE_UNAVAILABLE | 503 | Retry later and request a new plan |

## Verification on 2026-09-30

- Deterministic tests cover the unsigned message, fee payer and sole signer, instruction accounts/data, approved executor, default limits, existing Safe, cluster mismatch, account owner/discriminator, owner/mint/authority substitution, insufficient SOL, ATA/pre-funded PDA rent, orphan policy, expired fee lookup and simulation failure.
- Live Mainnet **unsigned simulation only**: owner `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, derived Safe `ETYmZNRkRbHfpfHVkhTiNQtRYDRf7T5CS4i4cXUkVWyE`, default executor `3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH`, slot `451992204`, `47559` CU. Missing rent `8595360`, fee `5000`, total `8600360` lamports (`0.00860036` SOL). No transaction signed/sent and no funds moved.
- Live Devnet check found the executor registry missing for program `8xa1…`; the API returns `EXECUTOR_UNAVAILABLE`. Devnet creation with default executor/limits needs an admin registry initialization before a live wallet test. This API does not silently fall back to a no-executor or no-limits creation path.
- Production compilation and TypeScript check passed. Local HTTP routes returned the simulated Mainnet creation plan and confirmed the existing owner's Safe `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ`.
- Idle cycle extension: 17 deterministic tests and 3 local HTTP tests passed, including amount/u64 precision, both transaction directions, canonical owner destination, missing-ATA creation, full/partial withdrawal, balance/SOL errors and simulation rejection. Mainnet unsigned simulations for existing `FuDC…`: deposit 1 USDC at slot `452023520`, `11733` CU; withdrawal 1 USDC at slot `452023524`, `11799` CU. Each quoted rent 0 and fee 5000 lamports (`0.000005 SOL`). These are separate simulations on existing balances, not a newly sent round trip. No keys used, no funds moved.

Run with Node 24 (native TypeScript stripping), from `web`: `npm run test:mobile-safe`, `node node_modules/typescript/bin/tsc --noEmit --incremental false`, `npm run build`. Read-only live probe: set `V2_MOBILE_CLUSTER`, the matching private RPC variable, optionally `MOBILE_PROBE_OWNER`, then `npm run probe:mobile-safe`. The probe has no signing/send methods.

For local HTTP integration checks start the app on port 3304 with `V2_MOBILE_CLUSTER=mainnet` and the private Mainnet RPC, then run `npm run probe:mobile-mainnet` (default port 3304). The HTTP checks send only read/build requests and cover configuration, the existing Safe, creation/deposit/partial/full withdrawal simulations and invalid/oversized requests. Set `MOBILE_TEST_BASE` to override the API base URL. The Mainnet probe simulates one raw USDC unit where a balance exists and also checks all-idle exit; empty balances are reported rather than invented. It never sends or signs.

The read-only probe supports `MOBILE_PROBE_OPERATION=create|deposit|withdraw`, `MOBILE_PROBE_OWNER`, and `MOBILE_PROBE_AMOUNT` (default `1` for transfers, or `all` for withdrawal). No live wallet round trip was submitted in this API change; the next acceptance check is owner-signed deposit, confirmation, then owner-signed withdrawal on the test interface/mobile app.

## EVM extension and parallel work

An Ethereum/Rabby/MetaMask EOA can later be a **Solana Safe owner** through EIP-712 plus a Solana relayer. This does not create a contract on Ethereum. Source funds can subsequently arrive through CCTP.

Keep the owner object (`type`, `address`) and explicit network across clients. Future `type: "evm"` uses a typed intent and relayer submission; it is not a Solana unsigned transaction requiring an EVM wallet to sign Ed25519. EVM Safe uses `vault_evm` seeds and a different account layout; existing Solana-owned Safe is not automatically converted and its assets/owner remain separate.

Parallel EVM branch/chat scope: finish EVM-authorized withdrawal, recipient/amount/nonce/deadline checks and negative tests, live Devnet USDC round trip, dedicated relayer budget, then CCTP return. Avoid edits to these Solana API routes until the shared owner/request contract is agreed. EVM Devnet withdrawal work has progressed in its separate branch; that does not constitute an accepted Mainnet EVM-owner release.

## Optional wallet RPC transport

`POST /rpc` accepts one JSON-RPC 2.0 call: `getGenesisHash`, `getBlockHeight`, or gated `sendTransaction` with base64 bytes (max 1232 bytes). No batch, arbitrary upstream URL, signer or fee payer is accepted. Same-origin browser requests and native clients without an Origin header are supported; browser CORS is not opened. Preflight is mandatory; retries resubmit the exact same signed bytes. Credentials stay server-side. This is RPC transport, not a durable broadcaster/job or application idempotency layer. On Mainnet the send gate defaults off. Ingress rate limits remain a public release prerequisite.


## Public Mainnet owner protocols (2026-10-05)

See [owner Kamino / Exponent API](yield-ai-v2-owner-protocol-api.md) for the dedicated public Mainnet host, unsigned protocol plans, setup, partial/full exits and recovery. Idle `/withdrawals/plan` keeps its original scope.
