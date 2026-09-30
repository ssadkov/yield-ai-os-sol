# Yield AI v2: Solana wallet Safe API v1 — USDC and Kamino cycle

Updated: 2026-10-01. Scope: read/create a personal Safe, deposit wallet USDC into it, withdraw idle USDC back to the owner, owner-deposit into the current Mainnet Kamino USDC vault from Safe or wallet, redeem shares partially/fully and return confirmed net proceeds. Each ready action returns one unsigned transaction. The existing Solana contract ABI is retained. Standalone allocation changes, portfolio NAV, agent history and EVM relay remain outside this API slice.

## Deployment and trust boundary

Withdrawal branch: `codex/yield-ai-v2-kamino-withdraw-api`, stacked on deposit PR #26 (`codex/yield-ai-v2-kamino-api`). Withdrawal PR #27 targets that deposit branch; #26 targets `codex/yield-ai-v2-cctp-engine`. The broader API stack is not yet in `main`. Merge dependencies in order and keep EVM work in its separate branch/worktree.

The server chooses one cluster with `V2_MOBILE_CLUSTER=devnet|mainnet` (default `devnet`). The caller must explicitly repeat that cluster. Private RPC variables: `V2_DEVNET_RPC_URL` for Devnet; `V2_MAINNET_RPC_URL` for Mainnet, with existing server-only Supanode header support. No program, mint, executor, signing key or arbitrary instruction is accepted from the caller. Do not put RPC credentials or server credentials in the mobile bundle.

| Cluster | Program | USDC mint |
| --- | --- | --- |
| Devnet | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Mainnet | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

Read and unsigned-plan endpoints are public. Only an actual owner signature on the Solana transaction changes chain state. Rate limits belong at the deployment ingress before opening this API broadly. Native mobile HTTP calls (native React Native/Flutter/Swift/Kotlin networking) do not require browser CORS. If HTTP calls instead run inside a WebView/browser, its actual Origin must be explicitly allowed along with `GET`, `POST`, `OPTIONS` and `Content-Type`; this branch adds no CORS middleware because no web origin has been specified. CORS is not wallet authorization. Vercel Preview access protection is separate and may block a native client too: do not bundle an operator/Vercel token in the app. Use an approved externally accessible test deployment for partner testing. [CORS reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS).

## API contract

Base URL: the deployment origin, followed by `/api/mobile/v1`. JSON responses have `Cache-Control: no-store`. USDC amounts are decimal strings with six digits; costs and SOL balances are integer lamport strings; times are unix milliseconds. Network/program/mint are explicit in every state response.

### GET /config

Returns `version`, `network` (`cluster`, `chain`, `genesis`, `programId`, `usdcMint`), `supportedOwnerTypes: ["solana"]`, wallet signing/submission, and capabilities. Safe creation, wallet deposits and idle USDC withdrawals are enabled; `protocolDeposits` and `protocolWithdrawals` are true on Mainnet only, `allocation` and `evmOwner` remain false, ordinary `withdrawalScope` is `idle_usdc`. `protocolRoutes` lists `kamino_usdc`, its fixed vault/program/shares mint, minimum deposit, `depositSources: ["safe", "wallet"]`, `withdrawalSelectors: ["shares", "percent"]` and `withdrawalPhases: ["redeem", "return"]`; it is empty on Devnet. Capability flags describe implemented endpoint features; each plan still checks live state and simulates.

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

The transaction contains a 200,000-CU limit and `initialize_with_limits`. It creates the Safe, its canonical USDC ATA and executor policy atomically. Allocation starts entirely idle. No USDC transfer, protocol deposit or arbitrary CPI is included. ATA rent is omitted if a valid ATA already exists; pre-funded empty System-owned PDAs need only the rent top-up. An orphan existing executor policy is rejected rather than reset.

If the Safe already exists, returns `status: "already_exists"`, current `state`, `steps: []`. Do not ask the wallet to sign. Repeating a plan request does not create anything: uniqueness is enforced by the owner PDA on chain. No durable server plan store or `Idempotency-Key` replay guarantee is implemented yet; fresh requests may have different blockhashes/plan IDs. That requirement from the broader backend specification is deferred to the signed-submission/job layer.

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

### POST /protocols/kamino/deposits/plan

Mainnet-only owner deposit into the current allowlisted Kamino USDC vault. Both sources require an existing initialized Solana-owned Safe. It does not create a Safe, accept an executor signature, or change the saved allocation target.

```json
{
  "cluster": "mainnet",
  "owner": { "type": "solana", "address": "YOUR_SOLANA_WALLET" },
  "source": "wallet",
  "amount": "2.000000"
}
```

Use `source: "safe"` to invest idle USDC already in the Safe, or `source: "wallet"` to transfer wallet USDC to the Safe and invest in Kamino atomically. `amount` is a positive decimal string with at most six decimals, minimum `1.000000`; no numeric JSON, percentages or `all`. The route is `91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy` under program `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd`; shares mint is `B9t9wg8r39Lxm2D9Gmqn2rJ5pVQQwjtGBfSsHAXSEnVe`. The caller cannot override vault, mint, recipient, allocation, executor, instruction data or compute price. [Kamino deposit reference](https://kamino.com/docs/build/developers/earn/operations/deposit).

The response retains the creation/idle plan envelope (`state`, `cost`, `blockhash`, `lastValidBlockHeight`, `simulation`, `planId`, `steps`). It adds:

```json
{
  "status": "ready",
  "scope": "kamino_usdc",
  "source": "wallet",
  "amount": "2.000000",
  "amountRaw": "2000000",
  "amountMeaning": "maximum_kamino_input",
  "sourceAccount": "CANONICAL_OWNER_USDC_ATA",
  "destinationSharesAta": "CANONICAL_SAFE_KAMINO_SHARES_ATA",
  "allocationBpsAfter": [5000, 0, 0, 0, 0, 0, 0, 0],
  "atomic": true
}
```

`route` contains the fixed vault/program/shares mint/minimum. `steps` contains exactly one unsigned v0 transaction (`kind: "kamino_deposit"`), with owner as sole signer and fee payer. LUT addresses are built into that transaction; the client does not insert instructions or lookup tables. The server loads the actual lookup tables from the configured RPC, not the KTX-provided address contents.

Instruction order: create a missing Safe USDC ATA if necessary; temporarily set 100% Kamino if needed; for `wallet` transfer the requested USDC into the Safe; create a missing Safe shares ATA; run the deployed typed `kamino_deposit`; restore the allocation observed at plan time. The owner approves this one-time investment irrespective of the saved executor target. There is no intermediate confirmation or persistent temporary 100% target: failure rolls back the whole transaction. If saved allocation is already 100% Kamino, both temporary allocation instructions are omitted. This does not grant the executor an exception to its limits; the endpoint only builds owner-signed actions.

The amount is Kamino's maximum input, not a guaranteed shares quote; the wallet path transfers that amount into the Safe and any amount not consumed by Kamino remains idle. The ABI has no `minSharesOut` argument. This API does **not** promise a share count, fixed APY or a slippage guarantee; the server simulation is a snapshot, not a reservation. Only the account list of a validated KTX deposit is used: setup, farm, and other raw KTX instructions are not forwarded. Shares stay unstaked in the Safe, matching the tested exit route; farm rewards are not included. The Safe contract records actual USDC spent as route principal. Before signing, show the source, amount, network, Safe, Kamino vault, missing-account rent and network fee. On confirmation, refresh the Safe and read the resulting shares through the existing position reader; `routePrincipalUsdc` is cost basis, not live NAV.

The compute limit is 400,000 CU, priority price zero. Quote includes current network fee and missing SPL ATA rent (including existing lamport top-ups). Fees/rent are paid in SOL by the owner. Do not assume zero rent on a new position. Follow the same signature persistence/timeout/expiry rules as ordinary deposits. If another device changes the allocation after this plan is built, a successful signed transaction restores the allocation in this plan; request a fresh plan after any settings change and serialize owner actions.

**Exit boundary:** `/withdrawals/plan` still withdraws only idle USDC. Use the protocol withdrawal endpoint's redeem/return phases below for Kamino shares. The existing `/v2/safe` interface remains an owner exit route. A complete supported USDC/Kamino exit does not sell other token positions; show their remaining balances separately.

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
| INVALID_SOURCE | 400 | Use safe or wallet for Kamino |
| AMOUNT_BELOW_MINIMUM | 422 | Current Kamino route requires at least 1 USDC |
| PROTOCOL_UNAVAILABLE | 409/503 | Kamino is Mainnet-only; stop if its program/vault is unavailable |
| INVALID_KAMINO_RESPONSE / KAMINO_UNAVAILABLE | 502 | No plan returned; retry or operator checks upstream |
| LOOKUP_TABLE_UNAVAILABLE | 503 | Refresh/retry; do not construct replacement tables |
| TRANSACTION_TOO_LARGE | 422 | No plan returned; operator checks route, do not split it in the client |
| SAFE_NOT_CREATED | 409 | Complete and confirm creation first |
| INSUFFICIENT_USDC | 422 | Refresh the source balance; protocol assets are outside idle withdrawal |
| INVALID_SHARES / INVALID_PERCENT / INVALID_SIGNATURE | 400 | Fix the withdrawal selector or receipt signature |
| INSUFFICIENT_SHARES | 422 | Refresh shares; do not increase the target silently |
| REDEMPTION_NOT_CONFIRMED / RPC_BEHIND_REDEMPTION | 409 | Wait/check the original signature and refresh RPC state |
| INVALID_REDEMPTION | 422 | Do not sign; inspect the unsuccessful or unrelated receipt |
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

For local HTTP integration checks start the app on port 3231 with `V2_MOBILE_CLUSTER=mainnet` and the private Mainnet RPC, then run `node --test scripts/mobile-safe-http.test.mjs`. The HTTP checks send only read/build requests and cover configuration, the existing Safe, creation/deposit/partial/full withdrawal simulations and invalid/oversized requests. Set `MOBILE_TEST_BASE` to override the API base URL. The positive transfer checks require the pilot owner to have at least 1 USDC in wallet and Safe; the current fixture is not a universally repeatable funded test.

The read-only probe supports `MOBILE_PROBE_OPERATION=create|deposit|withdraw|kamino_deposit`, `MOBILE_PROBE_OWNER`, `MOBILE_PROBE_SOURCE=safe|wallet` for Kamino, and `MOBILE_PROBE_AMOUNT` (default `1` for transfers, or `all` for idle withdrawal). No live wallet round trip was submitted in this API change; the next acceptance check is owner-signed deposit, confirmation, then owner-signed withdrawal on the test interface/mobile app.

- Kamino deposit extension: 27 deterministic tests passed, including both funding sources, allocation restoration, missing-ATA rent, sole owner signature, upstream amount/vault/mint/account/signer substitution, RPC lookup-table loading, source balances, SOL, network restrictions and simulation failure. TypeScript passed.
- Four local HTTP integration tests passed: existing creation/idle cycle, both Kamino sources, config capabilities and rejection of vault/recipient overrides, invalid source/amount and network mismatch.
- Full Next.js production compilation passed, including the new dynamic Kamino route. Local legacy static generation initially hit `429` on the default public Solana RPC; rebuilding with `NEXT_PUBLIC_RPC_URL=https://solana-rpc.publicnode.com` succeeded. This public RPC override was local only; Production environment was not changed. The mobile API simulations used the configured private Mainnet RPC.
- Read-only Mainnet unsigned simulations on `FuDC…`, 1 USDC: Safe source slot `452040526`, `136568` CU; wallet source slot `452040533`, `149472` CU. Existing ATAs required no new rent; each network fee quote was `5000` lamports (`0.000005 SOL`), priority fee zero. Nothing signed/sent, no funds moved. These are independent snapshot simulations, not a newly funded full cycle.

## Kamino withdrawal API: partial and full supported USDC exit

`POST /api/mobile/v1/protocols/kamino/withdrawals/plan` is Mainnet-only and owner-signed. It issues **one current step**, not a batch of transactions based on balances that do not yet exist. The deployed contract needs no upgrade for these owner operations. `/withdrawals/plan` still means idle USDC only; `/config` now advertises `protocolWithdrawals` and the Kamino selectors/phases separately.

### 1. Redeem a snapshot share target

```json
{
  "cluster": "mainnet",
  "owner": { "type": "solana", "address": "YOUR_SOLANA_WALLET" },
  "phase": "redeem",
  "percent": "50"
}
```

Use exactly one selector: `percent` (decimal string >0 and <=100, at most two decimals), or `shares` (positive raw u64 string, or `"all"`). Percentage refers to **Kamino shares**, excluding idle USDC and other positions; its raw target rounds down. A percentage rounding to zero returns `AMOUNT_BELOW_MINIMUM`. This version does not promise an exact USDC exit amount from an unvalued share balance.

The ready response includes `sharesBeforeRaw`, `targetSharesRaw`, `legSharesRaw`, `remainingTargetSharesRaw`, `performanceFeeBps`, `destination` (Safe USDC ATA), `allocationBpsAfter`, the usual cost/simulation/blockhash fields and one `kamino_redeem` step. SDK liquidity can require several reserve legs; only its first checked leg is included. All-share sentinels are replaced by the bounded snapshot target, preventing a later deposit from silently increasing the signed redemption amount. The contract's positive-profit fee is paid to its configured treasury; allocation is not changed.

If `shares:"all"` finds zero shares, response is `status:"redeemed"`, `steps:[]`, with `next` pointing to the existing idle `/withdrawals/plan` using `amount:"all"`. This means the Kamino position is empty; it does **not** mean USDC was transferred to the owner or other assets were sold.

### 2. Return the confirmed net proceeds to the wallet

Confirm the redemption signature first, then request:

```json
{
  "cluster": "mainnet",
  "owner": { "type": "solana", "address": "YOUR_SOLANA_WALLET" },
  "phase": "return",
  "redemptionSignature": "CONFIRMED_SOLANA_TRANSACTION_SIGNATURE"
}
```

The API reads the confirmed receipt and verifies success, sole owner signer, the typed Safe Kamino withdrawal, Safe identity, permitted outer instructions, and Safe USDC/shares pre/post balances. `netUsdc` is the actual Safe USDC increase **after** the performance fee; `burnedSharesRaw` is the actual share decrease. It builds one fixed-amount owner `withdraw` to the same owner's canonical USDC ATA, creating that ATA if absent and quoting its rent. It never accepts a destination override or a client-supplied receipt balance. A zero net amount returns `empty` with no transaction. Missing receipt is `REDEMPTION_NOT_CONFIRMED` (409); stale RPC state is `RPC_BEHIND_REDEMPTION` (409); failed/unrelated/incomplete receipts are `INVALID_REDEMPTION` (422). Insufficient current idle USDC returns the existing `INSUFFICIENT_USDC`, not an invented successful return.

### Continuation and recovery

Persist an operation journal on the device: network, owner, Safe, the **initial target raw shares**, outstanding raw shares, every redemption signature, actual burned shares, and every return signature with its blockhash/last-valid height. Reuse the same owner/network throughout.

1. After a redemption confirms, build its return using the receipt signature. Persist the return signature immediately after submission and confirm it.
2. Subtract **confirmed** `burnedSharesRaw` from the outstanding target. Request the next redemption with `shares:"REMAINING_RAW_SHARES"`. Do not repeat a percentage; it would calculate a different target from the smaller position. A returned `remainingTargetSharesRaw` is only the unsigned plan's expectation, until its receipt proves the burn.
3. Stop if shares do not decrease; cap automatic redemption attempts at eight and present remaining holdings for manual recovery. Changing liquidity or the exact bounded final-leg simulation can prevent an immediate complete exit; do not bypass checks with an unbounded all-shares instruction.
4. For a full supported exit, once the initial Kamino target is exhausted, separately request `/withdrawals/plan` with `amount:"all"` to return idle USDC that existed before the redemptions or any remaining USDC dust. Read fresh state and confirm that transfer. Other token positions remain outside this scope.
5. Partial exit returns only each redemption's net proceeds. Existing idle USDC stays in Safe. Its amount can instead be withdrawn explicitly through `/withdrawals/plan` when the owner requests it.

These plans are **not idempotent across newly signed transactions**. A receipt identifies the redemption, not whether a later wallet return has already occurred. Never automatically resubmit `phase:"return"` after a timeout or on restart: first check the persisted return signature and its expiry. Returning again after a successful return could consume other idle USDC if the owner signs it again. If a journal was lost, inspect the owner's transaction history before rebuilding a return; the API does not maintain a durable job ledger. A failed/declined return leaves redeemed USDC in Safe, available through the existing idle withdrawal API.

### Withdrawal verification (2026-10-01)

- 33 deterministic tests passed, including available/reserve legs, partial percentages, exact raw target continuation, bounded all-share sentinel, one owner signer, legacy account layout, unchanged allocation, treasury rent, SDK account substitution, invalid selectors, insufficient shares, simulation failures, net-after-fee return, missing/failed/unrelated/incomplete receipts and stale RPC state.
- Read-only current SDK probe for `FuDC…`, requested `1000000` raw shares: one available-liquidity leg, 18 accounts and one lookup table; the new validator accepted its current layout. The pilot currently has no shares, so this is an SDK account-layout check, **not a successful funded withdrawal simulation or live round trip**. Run `V2_MAINNET_RPC_URL=... node --experimental-strip-types scripts/mobile-kamino-withdraw-probe.mjs` from `web`, keeping the RPC secret in the environment.
- Wallet-signed funded partial/full API exit and interruption recovery remain acceptance checks before calling the new mobile flow tested with real funds. Existing earlier owner UI Mainnet withdrawals do not establish this API's new receipt-return flow.
- TypeScript and the full Next.js production build passed. Five local HTTP integration tests passed, including both existing deposit sources, the idle wallet cycle, a zero-shares Kamino exit and invalid exit selectors/receipt input. These HTTP requests did not sign or send transactions.

## EVM extension and parallel work

An Ethereum/Rabby/MetaMask EOA can later be a **Solana Safe owner** through EIP-712 plus a Solana relayer. This does not create a contract on Ethereum. Source funds can subsequently arrive through CCTP.

Keep the owner object (`type`, `address`) and explicit network across clients. Future `type: "evm"` uses a typed intent and relayer submission; it is not a Solana unsigned transaction requiring an EVM wallet to sign Ed25519. EVM Safe uses `vault_evm` seeds and a different account layout; existing Solana-owned Safe is not automatically converted and its assets/owner remain separate.

Parallel EVM branch/chat scope: finish EVM-authorized withdrawal, recipient/amount/nonce/deadline checks and negative tests, live Devnet USDC round trip, dedicated relayer budget, then CCTP return. Avoid edits to these Solana API routes until the shared owner/request contract is agreed. The demonstrated EVM creation/allocation is not sufficient to accept funds before withdrawal is verified.
