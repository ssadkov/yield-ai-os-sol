# EVM-owner USDC withdrawal: local validation

Current 2026-10-01 implementation and gates: [signed lifecycle, recovery fallback and dedicated relayer](yield-ai-v2-evm-lifecycle-relayer.md). New lifecycle code is tested locally, not deployed. The separate sponsor remains send-disabled and unfunded. Full live recovery finalized: Safe 0 USDC, nonce 3; recipient now 1 USDC. See [full recovery receipt](yield-ai-v2-evm-full-recovery-result.md). Historical receipts below retain their original observations.

Status: 2026-09-30. Owner-authorized idle-USDC withdrawal is implemented in this EVM worktree and passed the local checks below. **The separately approved Devnet upgrade is now finalized and its ELF hash verified.** The owner recovery cycle is still pending; ordinary funding/CCTP remains disabled. See [confirmed upgrade evidence](yield-ai-v2-evm-upgrade-result.md). No Mainnet upgrade, Production deployment or automatic relayer was performed.

## Authorization and accounts

The EIP-712 domain is unchanged:

~~~text
name: Yield AI Safe
version: 1
salt: bytes32(Solana program ID)
~~~

The independent primary type is:

~~~text
WithdrawUsdc(bytes32 genesisHash,bytes32 vault,bytes32 mint,uint64 amountRaw,bytes32 recipientTokenAccount,bytes32 recipientOwner,uint64 nonce,uint64 deadline)
~~~

Solana addresses are their raw 32 bytes. USDC amount is a raw unsigned integer: 0.1 USDC = 100000 raw units. JSON transports amountRaw, nonce and deadline as decimal strings. deadline is Unix seconds. There is no hostname or EVM chainId in this domain: the program is bound by salt and the Solana cluster by genesisHash. This is an EOA recovery signature; EIP-1271 contract-wallet ownership is outside this implementation.

The instruction is evm_withdraw_usdc(amount_raw, nonce, deadline, signature[65]). It reads the actual destination token account's address and token authority into the digest; these are not relayer-controlled aliases. Changing token authority after signing invalidates the signature even if the account address remains identical. The USDC mint and six decimals are fixed by the Devnet/default feature; only the original SPL Token program is accepted. The source is the canonical USDC ATA of the EvmVault PDA. The destination must already be an initialized account of the same mint. It may be a non-ATA account if the owner explicitly signs that exact account and authority; the web lab uses a canonical receiving ATA derived from a user-entered Solana wallet address.

The signer is recovered on-chain with nonzero low-s and recovery byte 0/1 or 27/28. Allocation and withdrawal share the existing Safe nonce: a signed nonce must be current + 1. There is no new counter or layout migration. The transfer uses transfer_checked, signed only by [vault_evm, evmAddress20, bump]. The Safe nonce advances after a successful CPI, atomically with the transfer. Zero amounts, insufficient idle USDC and source-as-recipient are rejected. Withdraw-all means signing the exact current idle balance; u64::MAX is not a sentinel.

The sponsor, agent, and recorded rent_payer do not authorize withdrawal. Existing Solana-owner withdraw and generic executor CPI reject an EvmVault discriminator. The owner does not need a Solana signer or a MetaMask Solana account. The first receiving address is a chosen Solana USDC account, not an address derived from the EVM owner. Returning to EVM through CCTP and recovery of other assets are separate work.

## Web verification and manual relay

/api/v2/evm-devnet keeps legacy allocation requests and adds action=withdraw_usdc. Withdrawal requests carry cluster=devnet, program, genesisHash, owner, safe, mint, amountRaw, recipientTokenAccount, recipientOwner, nonce, deadline, signature. GET exposes withdrawalEnabled. V2_EVM_DEVNET_WITHDRAW_ENABLED is a server-only flag and defaults to false. After a separately approved Devnet upgrade, it can be enabled for the separately approved small recovery test. It does not enable a deposit/CCTP flow or grant transaction approval.

POST validates the scope, canonical signature, live nonce, idle balance and destination mint/authority. POST never signs or sends. The EVM lab offers a withdrawal review and typed signature only when the gate is enabled and the Safe has idle USDC. A changed/disconnected wallet invalidates pending results. The client verifies the returned payload digest as well as its signature.

client/src/v2EvmOwnerRelay.ts accepts allocation or withdrawal. It verifies the signature before RPC, checks Devnet genesis, account ownership, source/destination token state, nonce/deadline, fee/rent caps and simulation. --preflight is unsigned and does not open any sponsor keypair. --send retains the transaction-specific acknowledgement and requires separate human approval. Once a signature has been submitted, the CLI prints the finalized receipt before read-back. A read-back error is not permission to repeat the withdrawal. A consumed/stale nonce is rejected; confirm the original receipt before requesting a new signature. This CLI has no durable service journal or unattended retry loop.

Creation remains permissionless and records the first payer. The withdrawal change grants that field no custody rights and adds no close/rent refund. A first-creation race may still invalidate an atomic creation/allocation transaction; re-read state and obtain a fresh signature rather than reinitializing the Safe. A pre-existing ATA may have a different original funder. Rent refunds require a separate policy.

## Reproducible local checks

Use the existing Linux/WSL toolchain and dependencies. From the EVM worktree:

~~~sh
NO_DNA=1 cargo test -p yield-vault --lib --features devnet --offline --locked
NO_DNA=1 cargo test -p yield-vault --lib --offline --locked
NO_DNA=1 anchor build --provider.cluster devnet -- --features devnet
cd web
node --test scripts/v2-evm-owner.test.mjs
node scripts/v2-evm-withdraw-local.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/typescript/bin/tsc --project ../client/tsconfig.json --noEmit --incremental false
~~~

The node:test API suite uses mocked read-only RPC. Both test scripts support the installed Node 20 by transpiling the actual shared helper in memory. The SBF runner launches its own solana-test-validator on 127.0.0.1:18899, with disposable fixtures and a ledger under /tmp. It never clones or connects to a public cluster and reads no wallet/keypair files. Ephemeral EVM/Solana signing keys stay in process memory; the runner writes public mint fixtures, validator logs and a disposable validator ledger; it never exports the owner/payer signing keys. All successful local transactions are simulated before sending. Confirmation uses HTTP and the validator is stopped when the test finishes.

Results:

- Devnet Rust: 17/17 passed, including the independent viem digest/recovery vector, field tampering, wrong action/domain, replay, expiry, canonical signatures and nonce overflow.
- Default Rust: 10/10 passed, including rejection of the Devnet withdrawal vector under the Mainnet domain.
- Client/API: 10/10 passed, including equivalent high-s rejection, exact raw u64 validation, legacy allocation compatibility, destination checks and closed deployment gate.
- Web/client TypeScript: passed. Next.js build in WSL passed, including /v2/evm-devnet and /api/v2/evm-devnet. No deployment was performed.
- Anchor ELF and IDL: built; binary bytes 688864, SHA-256 fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489. Only the EVM web IDL was updated; the Solana-owner web IDL and Solana API files were not edited.
- Local SBF: 1.000000 disposable USDC transferred into Safe; owner-authorized partial withdrawal 0.100000; allocation at the next shared nonce; owner-authorized withdrawal of the remaining 0.900000. Final source 0 raw, recipient 1000000 raw, nonce 3. Safe account remains 705 bytes.
- 25 negative SBF simulations rejected: amount, destination, mint, Safe, token program and source substitution; legacy withdraw/executor CPI; absent intent and wrong EVM owner; wrong cluster/program/action; equivalent high-s and invalid recovery byte; expiry/nonce skip; zero/over-balance/self transfer; changed destination authority; frozen-recipient CPI; and withdrawal/allocation replay in both directions. Fresh simulation messages bypass the runtime transaction cache; withdrawal replay failed with InvalidNonce. Each rejection preserved observed balances and nonce.

## Confirmed local receipts (not Devnet transactions)

Final local-only Safe: G8x7qDbE2dEcYpWtPEVL3tTos4dF2KeaBMTBwQfcZJpq.
Source ATA: 9dwLoYbAgRtpZnssXSuzzwm1xpJxbEHeJ934aLNkpCMb.
Recipient token account: GFDxKo65iM1SoBUhGucwP7u3S93mMZ33Fgzuvf9us8pD.

- Deposit: 5bJdSpAeqbeETpxNmAayWvMn4ADyaz62hGATgFAkD2MiQpdas7Jv3umGMqFawESjiHJ5p6kbeQQJf9CztqkGCBtE (6200 simulated CU).
- Partial withdrawal: SNNHyHvJksbgVWjCgZjmpgV3vi2P6XzV44HCrQ1HVRT9HsPk8WQA1n4XdPfZRBQjdAfVGHXSCZtZCFqWvSBBCgN (44823 CU).
- Remaining withdrawal: Z3rbCUySuZv1rWTjjrwbyS6WucSriMJkkpkiYPGgbMEdaDXmyTUSp1rT51RNV3SVSyBiV1x7JXr9cKNnGCPVgWZ (44821 CU).

Public signature fixture: programs/yield-vault/tests/fixtures/evm-withdraw.json. It is independent of these ephemeral local-run owners and of the user's MetaMask address. No private fixture key is stored.

## Remaining gate before the user deposits on Devnet

Prepare the new binary's Devnet upgrade preflight, re-read deployment authority/ProgramData and costs, and obtain separate transaction-specific approval. Re-read the user's Safe and nonce before any signature. Then separately review and authorize a minimal test-USDC deposit/owner withdrawal cycle to the user's chosen existing Solana token account. Keep ordinary funding/CCTP disabled until that live recovery cycle is verified. Dedicated service relayer keys, spend limits, durable submission journal, rent closure and EVM return remain separate work. Mainnet upgrade and Production deployment require separate approval.

Read-only Devnet upgrade preparation is now complete: see [the exact operation, costs and approval packet](yield-ai-v2-evm-upgrade-preflight.md). The upgrade subsequently finalized after separate approval; see [execution evidence](yield-ai-v2-evm-upgrade-result.md). No funding or owner-withdrawal transaction was sent.
