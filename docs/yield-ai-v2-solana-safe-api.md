# Yield AI v2: Solana wallet Safe API v1

Date: 2026-09-30. Scope: read a personal Safe and construct one unsigned creation transaction. The existing Solana contract ABI is retained. This is the first API slice for the mobile/backend specification, not the complete deposits/portfolio/agent API.

## Deployment and trust boundary

Base branch: `codex/yield-ai-v2-cctp-mainnet`. `main` does not yet contain the complete tested executor policy. Keep this API and EVM work in separate branches/worktrees.

The server chooses one cluster with `V2_MOBILE_CLUSTER=devnet|mainnet` (default `devnet`). The caller must explicitly repeat that cluster. Private RPC variables: `V2_DEVNET_RPC_URL` for Devnet; `V2_MAINNET_RPC_URL` for Mainnet, with existing server-only Supanode header support. No program, mint, executor, signing key or arbitrary instruction is accepted from the caller. Do not put RPC credentials or server credentials in the mobile bundle.

| Cluster | Program | USDC mint |
| --- | --- | --- |
| Devnet | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Mainnet | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

Read and unsigned-plan endpoints are public. Only an actual owner signature on the Solana transaction changes chain state. Rate limits belong at the deployment ingress before opening this API broadly. Native mobile HTTP calls do not require browser CORS. Separate web origins will need an explicit CORS policy.

## API contract

Base URL: the deployment origin, followed by `/api/mobile/v1`. JSON responses have `Cache-Control: no-store`. USDC amounts are decimal strings with six digits; costs and SOL balances are integer lamport strings; times are unix milliseconds. Network/program/mint are explicit in every state response.

### GET /config

Returns `version`, `network` (`cluster`, `chain`, `genesis`, `programId`, `usdcMint`), `supportedOwnerTypes: ["solana"]`, wallet signing/submission, and capabilities. Capability flags describe implemented endpoint features; a creation plan still checks the live program and registry. Deposits, withdrawals and EVM-owner capabilities are false in this slice.

### GET /safes?ownerType=solana&address=OWNER&cluster=mainnet

Returns canonical `safe`, `usdcAta`, `executorLimitsAddress`, `exists`, `usdcAccountExists`, wallet SOL, **idle** USDC, allocation, assigned executor, its current approval, current default executor, and on-chain executor limits. `idleUsdc` is not total portfolio NAV and excludes Kamino shares and other assets. An existing legacy Safe can have `executorLimits: null`; reading it does not migrate or reset it.

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

The transaction contains a 200,000-CU limit and `initialize_with_limits`. It creates the Safe, its canonical USDC ATA and executor policy atomically. Allocation starts entirely idle. No USDC transfer, protocol deposit or arbitrary CPI is included. ATA rent is omitted if a valid ATA already exists; pre-funded empty System-owned PDAs need only the rent top-up. An orphan existing executor policy is rejected rather than reset.

If the Safe already exists, returns `status: "already_exists"`, current `state`, `steps: []`. Do not ask the wallet to sign. Repeating a plan request does not create anything: uniqueness is enforced by the owner PDA on chain. No durable server plan store or `Idempotency-Key` replay guarantee is implemented yet; fresh requests may have different blockhashes/plan IDs. That requirement from the broader backend specification is deferred to the signed-submission/job layer.

Insufficient owner SOL returns HTTP 422 `INSUFFICIENT_SOL` with `error.details.cost`, network and Safe, so mobile can show the exact funding requirement. Estimated rent and fee are a snapshot, not a reservation. Wallet-added priority fees change the final cost.

## Mobile flow

1. Connect Seeker/Seed Vault, Phantom, Solflare, Backpack or another supported Solana signer via the existing mobile wallet bridge.
2. Read `/config`; require the displayed network and actual wallet transaction network to match.
3. Read `/safes`. If it exists, continue to the Safe view. If absent, request the creation plan.
4. Show network, Safe, executor/limits, rent and fee. Before signing, deserialize the transaction and check the displayed owner is the sole signer/fee payer, the program and addresses match config, and the instructions are the expected creation operation. Use Solana transaction signing, not `signMessage`.
5. Ask the wallet to sign and send once. Alternatively use its `signTransaction` then submit through the application's trusted Solana transport. This API version does not provide a generic broadcaster or hold a server key.
6. Keep the signature and `lastValidBlockHeight`. Confirm it through the wallet/RPC, then refresh `/safes` until the initialized Safe appears. On timeout first check signature status and state: do not blindly sign again. A missing signature alone does not prove failure.
7. On expired blockhash, request a fresh plan. If another device has already created the Safe, the fresh response is `already_exists`. For an on-chain failed creation, present the failure and rebuild only after refreshing state.

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
| SIMULATION_FAILED | 422 | Refresh state; no transaction is returned |
| RPC_CLUSTER_MISMATCH / PROGRAM_UNAVAILABLE / INVALID_ACCOUNT | 503 | Stop signing; operator investigates configuration/state |
| EXECUTOR_UNAVAILABLE | 503 | Admin must initialize/unpause the approved default |
| BLOCKHASH_UNAVAILABLE / SERVICE_UNAVAILABLE | 503 | Retry later and request a new plan |

## Verification on 2026-09-30

- Deterministic tests cover the unsigned message, fee payer and sole signer, instruction accounts/data, approved executor, default limits, existing Safe, cluster mismatch, account owner/discriminator, owner/mint/authority substitution, insufficient SOL, ATA/pre-funded PDA rent, orphan policy, expired fee lookup and simulation failure.
- Live Mainnet **unsigned simulation only**: owner `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, derived Safe `ETYmZNRkRbHfpfHVkhTiNQtRYDRf7T5CS4i4cXUkVWyE`, default executor `3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH`, slot `451992204`, `47559` CU. Missing rent `8595360`, fee `5000`, total `8600360` lamports (`0.00860036` SOL). No transaction signed/sent and no funds moved.
- Live Devnet check found the executor registry missing for program `8xa1…`; the API returns `EXECUTOR_UNAVAILABLE`. Devnet creation with default executor/limits needs an admin registry initialization before a live wallet test. This API does not silently fall back to a no-executor or no-limits creation path.
- Production compilation and TypeScript check passed. Local HTTP routes returned the simulated Mainnet creation plan and confirmed the existing owner's Safe `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ`.

Run with Node 24 (native TypeScript stripping), from `web`: `npm run test:mobile-safe`, `node node_modules/typescript/bin/tsc --noEmit --incremental false`, `npm run build`. Read-only live probe: set `V2_MOBILE_CLUSTER`, the matching private RPC variable, optionally `MOBILE_PROBE_OWNER`, then `npm run probe:mobile-safe`. The probe has no signing/send methods.

For local HTTP integration checks start the app on port 3231 with `V2_MOBILE_CLUSTER=mainnet` and the private Mainnet RPC, then run `node --test scripts/mobile-safe-http.test.mjs`. The HTTP checks also send only read/build requests and cover configuration, the existing Safe, successful creation simulation and invalid/oversized requests. Set `MOBILE_TEST_BASE` to override the API base URL.

## EVM extension and parallel work

An Ethereum/Rabby/MetaMask EOA can later be a **Solana Safe owner** through EIP-712 plus a Solana relayer. This does not create a contract on Ethereum. Source funds can subsequently arrive through CCTP.

Keep the owner object (`type`, `address`) and explicit network across clients. Future `type: "evm"` uses a typed intent and relayer submission; it is not a Solana unsigned transaction requiring an EVM wallet to sign Ed25519. EVM Safe uses `vault_evm` seeds and a different account layout; existing Solana-owned Safe is not automatically converted and its assets/owner remain separate.

Parallel EVM branch/chat scope: finish EVM-authorized withdrawal, recipient/amount/nonce/deadline checks and negative tests, live Devnet USDC round trip, dedicated relayer budget, then CCTP return. Avoid edits to these Solana API routes until the shared owner/request contract is agreed. The demonstrated EVM creation/allocation is not sufficient to accept funds before withdrawal is verified.
