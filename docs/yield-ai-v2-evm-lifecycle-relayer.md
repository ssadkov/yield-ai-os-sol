# EVM Safe lifecycle and Devnet relayer — 2026-10-01

## Transaction permission policy — 2026-10-01

The user explicitly changed the rule: Devnet transactions in the agreed EVM Safe scope do not require another chat approval. Mainnet transactions require separate explicit approval. Production deployment remains separately gated. Owner EIP-712 authorization, simulation, exact account/amount checks, binary pinning, spending limits and receipt verification remain mandatory.

After the reviewed lifecycle upgrade and sponsor funding are independently verified, the private local Devnet service may use sendEnabled=true, automatic=true and automaticApproval=DEVNET_OWNER_SIGNED_INTENTS_WITH_LIMITS within its existing owner allowlist and caps. This is an operational permission to relay valid owner intents; it cannot replace an owner signature. Sender ACK environment variables are operator guardrails, not additional human approval prompts. Ordinary funding/CCTP and Mainnet rollout remain outside the enabled flow.


## Current state and gates

Branch: codex/yield-ai-v2-evm-owner, base commit bbc23fb. This source release is tracked on the EVM branch in PR23. Lifecycle upgrade and sponsor funding finalized; the local bounded automatic service is enabled. Fresh human-wallet creation, a 1-USDC deposit and full owner-authorized withdrawal through the dedicated relayer are finalized. Current new Safe: 0 USDC, nonce 2. See [completed recovery cycle](yield-ai-v2-evm-new-owner-withdraw-result.md). Live cancellation of a competing pending intent remains unperformed. The main checkout and Solana API PR #24 were not edited.

The deployed Devnet lifecycle ELF is 695488 bytes, SHA256 4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98. The upgrade finalized at slot 506207702; independent readback verified hash, authority, zero padding, buffer refund and unchanged existing Safe. See [release evidence](yield-ai-v2-evm-lifecycle-release-result.md).

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

The manual allocation/withdrawal CLI remains an alternate-payer fallback, using V2_EVM_ALLOWED_PAYER and a protected V2_PAYER_KEYPAIR supplied only to the operator process. It never automatically creates a missing Safe. The wallet owner signs the EIP-712 intent; the Solana payer only pays fees. New lifecycle intents use the bounded service path.

## Separate sponsor service

Public sponsor: GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s. The signer, service config and JSONL journal live in a private Linux/WSL operator directory outside Git. They are not loaded by Next.js. The web process has access only to a scoped submit-token file, not the admin token, config or signer. No credentials or key material are included in these documents.

The service binds 127.0.0.1:3102. Library configuration supports disabled sends; the verified private Devnet runtime now has sendEnabled=true, automatic=true, allowLifecycle=true. It pins the currently deployed ELF size/hash and requires zero reserved padding. Code changes pause quotes/sends. It verifies Devnet genesis, ProgramData, upgrade authority, EVM owner allowlist, exact next nonce, token accounts, balances, TTL and simulated post-state. It rejects an upgrade-authority key as service payer and builds exactly one supported instruction.

Current caps: fee 5000 lamports, rent 10000000, rolling daily spending 20000000 (0.02 SOL), at most 10 hourly submissions, minimum remaining sponsor balance 10000000 (0.01 SOL). The sponsor received 0.05 test SOL. After independent verification, bounded automatic sending was explicitly enabled under the current Devnet policy.

POST /jobs validates and simulates an owner intent and creates a public quote. GET /jobs/:digest returns public status. The separate admin endpoint POST /jobs/:digest/approve requires the reviewed planHash, fresh preflight and enabled sends. Submit credentials cannot call approve. Automatic execution is enabled by the bounded Devnet policy acknowledgement in protected config. Each POST /jobs still needs a valid allowlisted owner intent and fresh simulation/budget checks; no extra chat approval is required.

Jobs are serialized through one worker. Before RPC submission the service stores the exact signed transaction, signature, blockhash lifetime and spending reservation in a single-writer journal and fsyncs both file and directory. Transport uncertainty retains the reservation. Restart checks the original signature and exact approved instruction; it never signs a replacement transaction automatically. Only the same signed bytes may be retransmitted while valid. Unknown reservations never age out of spending caps. Truncated/corrupt journal or stale lock requires operator inspection; do not delete history to unblock a retry.

The proxy at /api/v2/evm-relay uses a fixed loopback upstream, scoped credential, same-origin JSON submission, body limit, owner signature verification, response digest binding and a public-field allowlist. It does not expose an approval endpoint. Keep it local; remote public deployment needs separate authorization and service authentication/operational review.

Live local HTTP checks passed: no credential → 401; submit credential at approve → 401; admin approve with sends disabled → 409; malformed intent → 409. The preview at http://localhost:3101/v2/evm-devnet has lifecycle enabled and the funded dedicated sponsor shown. The fresh runtime checks reject unsigned, expired/consumed and foreign-origin submissions; see [preview report](yield-ai-v2-evm-preview-result.json). Browser wallet hardware/mobile behavior still needs a fresh human check; API tests do not establish support for every EVM wallet.

## Validation

- Rust: 20 devnet-feature tests and 11 default-feature tests passed. Default domain rejects Devnet lifecycle signatures.
- API: 18 tests passed, covering withdrawal, creation/cancel gates and sponsor changes, replay/expiry, malleability, missing Safe and proxy boundaries.
- Relayer: 13 tests passed, including journal restart, corruption, reservations/budgets, disabled send, original-signature recovery, binary pin, upgrade-authority rejection and wrong saved wire.
- Final SBF localnet cycle passed signed creation, sponsor substitution/unsigned creation rejection, 1-USDC deposit, partial/full alternative-payer withdrawal, cancellation, stale-action rejection and empty-balance recovery. It rejected 28 malformed/unauthorized actions. The expanded quote → approved signed bytes → submitted → finalized cycle and journal restart also passed; see [local-only receipt](yield-ai-v2-evm-lifecycle-local-result.json), finalized fee 5000 lamports.
- Next.js build and client TypeScript passed. Build emitted existing Anchor macro warnings / optional bigint fallback, and unrelated static-page RPC retries; no build error remained.

Reproduce from WSL in the EVM worktree (NO_DNA=1): cargo test -p yield-vault --features devnet --lib; cargo test -p yield-vault --lib; node --test web/scripts/v2-evm-owner.test.mjs web/scripts/v2-evm-relay-api.test.mjs; from client, node --import tsx --test ../web/scripts/v2-evm-relayer.test.mjs; node --import tsx ../web/scripts/v2-evm-withdraw-local.mjs; tsc --noEmit; from web, next build.

## Finalized Devnet release and current service

The lifecycle upgrade and 0.05 test-SOL funding both finalized. See [exact transaction receipts, costs, independent hash/readback and current gates](yield-ai-v2-evm-lifecycle-release-result.md). Six additional live-program simulations passed without sending or creating test accounts. The configured service now pins the new hash/size, allows lifecycle and executes allowlisted owner-signed intents automatically within the existing limits. Its service signer has no upgrade authority.

A second human EVM account has now been added for the fresh create/deposit/cancel/withdraw rehearsal: 0xb659DA13418527601C52D4220536C12397F20855. Its new Safe creation is finalized with nonce 1 and zero USDC; see [human creation receipt](yield-ai-v2-evm-human-creation-result.md). The allowlist remains narrow. The dedicated service finalized both the new human-owner creation and full 1-USDC withdrawal. The manual operator only supplied the test-USDC deposit. Current new Safe: 0 USDC, nonce 2; recipient 2 USDC. See [completed recovery cycle](yield-ai-v2-evm-new-owner-withdraw-result.md). Live cancellation of a competing pending intent remains unperformed; cancellation and journal restart have local SBF/test evidence.

## Upgrade governance proposal — not activated

The current single upgrade authority can replace authorization logic. A separate service key and spending caps do not remove that trust. Proposed policy is Squads v4, 2-of-3 distinct human/hardware signers, 48-hour timelock and autonomous config_authority (default public key), with the relayer excluded from membership and upgrade authority. The user-selected public Solana member addresses and standalone one-hour Devnet Squads creation are now recorded below. Human voting/delayed execution and an independently verified authority-transfer rehearsal are still required. Yield AI upgrade authority is not yet controlled by that multisig.

Squads documents that a [timelock](https://docs.squads.so/main/development/reference/time-locks) delays execution after threshold approval and that [external config authority](https://docs.squads.so/main/development/reference/accounts) can change configuration; avoid treating threshold as protection while an unchecked external config authority can bypass its governance. Solana supports [authority transfer or permanent removal](https://solana.com/docs/programs/deploying); immutable deployment is a later explicit decision, not a claimed current guarantee.

Publish reviewed binary hash and change scope before upgrades, allow the withdrawal window to pass, monitor authority/code changes and stop new funding on unexpected change. All Mainnet transactions, including upgrade, bridge funding and authority transfer, need separate approval. Production deployment also remains separately gated. Devnet operations follow the current policy above. CCTP inbound and return-to-EVM recovery follow only after these Devnet recovery and service gates; existing Solana-owner CCTP code is not an EVM-Safe integration.

## Devnet governance rehearsal update — 2026-10-01

A standalone Squads v4 multisig has now been created and independently verified with the three user-selected Solana wallet members, threshold 2 of 3, one-hour Devnet timelock and no external config authority. Yield AI upgrade authority is still the operator; no authority transfer has occurred. Human voting/delayed execution and live EVM cancellation remain pending. See [exact receipt, wallet steps, unsigned Memo simulation and remaining gates](yield-ai-v2-evm-governance-rehearsal.md). The 48-hour Mainnet governance proposal remains unactivated.
