# EVM Safe lifecycle and Devnet relayer — 2026-10-01

## Current state and gates

Branch: codex/yield-ai-v2-evm-owner, base commit bbc23fb. This source release is tracked on the EVM branch in PR23; the lifecycle upgrade and live dedicated-relayer cycle remain pending. The main checkout and Solana API PR #24 were not edited.

The deployed Devnet withdrawal ELF remains 688864 bytes, SHA256 fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489. The prepared lifecycle ELF is 695488 bytes, SHA256 4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98. No lifecycle upgrade was sent.

Safe B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu now holds 0 raw test-USDC, nonce 3 after full owner-authorized recovery. Its original rent payer remains 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A. The already finalized human-signed 0.1 withdrawal is documented in [the receipt](yield-ai-v2-evm-withdraw-result.md).

The user's subsequent 0.9-USDC intent, nonce 3, deadline 1790804147, expired at 2026-09-30 21:35:47 UTC before separate send approval. It was not sent. A newer owner signature (deadline 1790833798, nonce 3) and separate user approval subsequently produced a finalized 0.9-USDC withdrawal. Independent receipt/readback confirm source 0.9 -> 0, recipient 0.1 -> 1 USDC, nonce 2 -> 3. See [full recovery receipt](yield-ai-v2-evm-full-recovery-result.md). The manual Devnet recovery gate is complete; ordinary funding/CCTP stay disabled pending lifecycle/service/governance gates.

## Signed creation and cancellation

The domain is unchanged: name Yield AI Safe, version 1, salt = raw 32 bytes of the Solana program ID. Every message binds the compiled cluster genesis hash. No hostname is signed.

Exact primary types and field order:

~~~text
CreateSafe(bytes32 genesisHash,bytes32 vault,bytes32 mint,bytes32 rentPayer,uint64 nonce,uint64 deadline)
CancelIntents(bytes32 genesisHash,bytes32 vault,uint64 nonce,uint64 deadline)
~~~

create_evm_safe_authorized requires the actual EVM owner's canonical low-s signature. It binds the exact Safe, mint and Solana rent payer, accepts creation nonce 1, records that payer and consumes nonce 1. The 705-byte EvmVault layout and PDA seeds remain unchanged. The legacy create_evm_safe ABI is retained but fails with OwnerSignatureRequired in the prepared binary; initialization debits roll back atomically. A third party cannot first-create through this new path without the owner's matching intent. Existing Safes are preserved, including their historical rent payer.

A copied valid creation signature can submit the same creation first. It cannot change the payer, owner or mint. Creation consumes the counter, so replay after account existence fails. This does not prove exclusive transport or prevent someone relaying the authorized action earlier.

evm_cancel_intents consumes the next shared nonce through a separate signature type, moves no tokens and keeps all account state except nonce unchanged. Cancellation competes with a pending action at the same next nonce. It cannot undo an action that wins first, and it is not blanket revocation of arbitrarily pre-signed future nonces. The UI signs only fresh next-nonce intents and explains this race.

Safe close and rent refund remain disabled. Closing/recreating the same PDA would reset nonce and could make an old unexpired signature valid again. A future close policy needs persistent generation/tombstone state and a separate owner intent binding refund destinations. Full withdrawal leaves the empty Safe and token account in place; it does not refund rent. The recorded sponsor has no authority to withdraw USDC.

## Signing UX and fallback

The EVM lab requires review acknowledgement before signing; shows cluster, Safe, next nonce, expiry, withdrawal amount, recipient wallet and exact token account; handles account changes, disconnects and EIP-1193 rejection/unsupported-signature errors. Account selection is re-read before and after the wallet signature. A signature authorizes the action and can be relayed by anyone who holds it; copying it is not merely a harmless preview.

The recipient Solana wallet is an explicitly chosen withdrawal destination. It is not derived from MetaMask/Rabby. EVM wallet ownership is the 20-byte EVM address. Safe and ATA are program addresses on Solana, not a MetaMask Solana account.

The manual allocation/withdrawal CLI remains an alternate-payer fallback, using V2_EVM_ALLOWED_PAYER and a protected V2_PAYER_KEYPAIR supplied only to the operator process. It never automatically creates a missing Safe. The wallet owner signs the EIP-712 intent; the Solana payer only pays fees. New lifecycle intents use the separately gated service path.

## Separate sponsor service

Public sponsor: GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s. The signer, service config and JSONL journal live in a private Linux/WSL operator directory outside Git. They are not loaded by Next.js. The web process has access only to a scoped submit-token file, not the admin token, config or signer. No credentials or key material are included in these documents.

The service binds 127.0.0.1:3102. Default config has sendEnabled=false, automatic=false, allowLifecycle=false. It pins the currently deployed ELF size/hash and requires zero reserved padding. Code changes pause quotes/sends. It verifies Devnet genesis, ProgramData, upgrade authority, EVM owner allowlist, exact next nonce, token accounts, balances, TTL and simulated post-state. It rejects an upgrade-authority key as service payer and builds exactly one supported instruction.

Current caps: fee 5000 lamports, rent 10000000, rolling daily spending 20000000 (0.02 SOL), at most 10 hourly submissions, minimum remaining sponsor balance 10000000 (0.01 SOL). The new sponsor is unfunded. Funding it does not itself enable sending or automatic approvals.

POST /jobs validates and simulates an owner intent and creates a public quote. GET /jobs/:digest returns public status. The separate admin endpoint POST /jobs/:digest/approve requires the reviewed planHash, fresh preflight and enabled sends. Submit credentials cannot call approve. Automatic execution additionally requires explicit budget authorization and an acknowledgement in protected config; it is not enabled.

Jobs are serialized through one worker. Before RPC submission the service stores the exact signed transaction, signature, blockhash lifetime and spending reservation in a single-writer journal and fsyncs both file and directory. Transport uncertainty retains the reservation. Restart checks the original signature and exact approved instruction; it never signs a replacement transaction automatically. Only the same signed bytes may be retransmitted while valid. Unknown reservations never age out of spending caps. Truncated/corrupt journal or stale lock requires operator inspection; do not delete history to unblock a retry.

The proxy at /api/v2/evm-relay uses a fixed loopback upstream, scoped credential, same-origin JSON submission, body limit, owner signature verification, response digest binding and a public-field allowlist. It does not expose an approval endpoint. Keep it local; remote public deployment needs separate authorization and service authentication/operational review.

Live local HTTP checks passed: no credential → 401; submit credential at approve → 401; admin approve with sends disabled → 409; malformed intent → 409. The preview at http://localhost:3101/v2/evm-devnet has lifecycle disabled and sponsor shown. Browser wallet hardware/mobile behavior still needs a fresh human check; API tests do not establish support for every EVM wallet.

## Validation

- Rust: 20 devnet-feature tests and 11 default-feature tests passed. Default domain rejects Devnet lifecycle signatures.
- API: 18 tests passed, covering withdrawal, creation/cancel gates and sponsor changes, replay/expiry, malleability, missing Safe and proxy boundaries.
- Relayer: 13 tests passed, including journal restart, corruption, reservations/budgets, disabled send, original-signature recovery, binary pin, upgrade-authority rejection and wrong saved wire.
- Final SBF localnet cycle passed signed creation, sponsor substitution/unsigned creation rejection, 1-USDC deposit, partial/full alternative-payer withdrawal, cancellation, stale-action rejection and empty-balance recovery. It rejected 28 malformed/unauthorized actions. The expanded quote → approved signed bytes → submitted → finalized cycle and journal restart also passed; see [local-only receipt](yield-ai-v2-evm-lifecycle-local-result.json), finalized fee 5000 lamports.
- Next.js build and client TypeScript passed. Build emitted existing Anchor macro warnings / optional bigint fallback, and unrelated static-page RPC retries; no build error remained.

Reproduce from WSL in the EVM worktree (NO_DNA=1): cargo test -p yield-vault --features devnet --lib; cargo test -p yield-vault --lib; node --test web/scripts/v2-evm-owner.test.mjs web/scripts/v2-evm-relay-api.test.mjs; from client, node --import tsx --test ../web/scripts/v2-evm-relayer.test.mjs; node --import tsx ../web/scripts/v2-evm-withdraw-local.mjs; tsc --noEmit; from web, next build.

## Prepared on-chain operations — no approval or send yet

[Lifecycle upgrade preflight](yield-ai-v2-evm-lifecycle-upgrade-preflight.json): program 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5, ProgramData H5evLv9yEPaSRacNTYv5y4Tjdj3gJByUgavwMg66xTBg, payer/authority 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A. ExtendProgram by 10240 bytes simulates successfully; resulting ProgramData 699149 bytes. Additional rent 52019200 lamports (0.0520192 test SOL). Upload buffer 2HGHeWBCe1b5MDr4c4jwYocUKJ2WXfxzPkpi6o5eo2dV needs temporary 3533957880 lamports (3.533957880 SOL), returned to payer by successful upgrade. Estimated one-pass fees ≤3640000 lamports; proposed retry fee cap 50000000. Maximum net spend including additional rent and cap is 0.1020192 test SOL. Peak funding with cap is 3.635977080 test SOL. Full upgrade simulation is not claimed because the new buffer has not been created/uploaded. The preflight snapshot predates the now-completed full recovery. Re-read empty-Safe state, program hash and costs and obtain separate exact-operation approval before any extension/upload/upgrade.

[Relayer funding preflight](yield-ai-v2-evm-relayer-funding-preflight.json): unsigned System Program transfer from 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A to GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s, amount 0.05 test SOL, fee 0.000005 SOL, rent 0. Simulation passed, no transaction sent. Requires its own send approval. Automatic-service authorization remains a distinct later decision.

## Upgrade governance proposal — not activated

The current single upgrade authority can replace authorization logic. A separate service key and spending caps do not remove that trust. Proposed policy is Squads v4, 2-of-3 distinct human/hardware signers, 48-hour timelock and autonomous config_authority (default public key), with the relayer excluded from membership and upgrade authority. Public signer addresses, Devnet rehearsal and a separately approved authority-transfer transaction are still required. No multisig or timelock is currently on-chain for this program.

Squads documents that a [timelock](https://docs.squads.so/main/development/reference/time-locks) delays execution after threshold approval and that [external config authority](https://docs.squads.so/main/development/reference/accounts) can change configuration; avoid treating threshold as protection while an unchecked external config authority can bypass its governance. Solana supports [authority transfer or permanent removal](https://solana.com/docs/programs/deploying); immutable deployment is a later explicit decision, not a claimed current guarantee.

Publish reviewed binary hash and change scope before upgrades, allow the withdrawal window to pass, monitor authority/code changes and stop new funding on unexpected change. Mainnet upgrade, Production deployment, bridge funding and authority transfer each need separate approval. CCTP inbound and return-to-EVM recovery follow only after these Devnet recovery and service gates; existing Solana-owner CCTP code is not an EVM-Safe integration.
