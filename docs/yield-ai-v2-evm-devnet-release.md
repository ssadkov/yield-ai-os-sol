# Devnet EVM lifecycle release and sponsor rehearsal

Prepared 2026-10-01 after finalized full recovery; no new upgrade/funding send has been authorized or performed. Main checkout remains unchanged.

## Compatibility and release artifact

PR23 targets codex/yield-ai-v2-cctp-mainnet. Current base 9bdfe72 includes merged PR24 and PR25 Solana mobile API work. A three-dot comparison to the EVM branch shows those updates touch API/web/docs only; no Rust/Cargo program changes exist on that side. This EVM release changes EVM instructions and retains the existing Solana Vault ABI/layout. Solana API source files are not edited by this work.

ELF target/deploy/yield_vault.so: 695488 bytes, SHA256 4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98. Build: Anchor 0.32.1, Solana 3.1.12, Rust 1.89; anchor build --provider.cluster devnet -- --features devnet. Last SBF and relayer localnet cycle used this exact hash; see [result](yield-ai-v2-evm-lifecycle-local-result.json).

## Approval A: exact Devnet upgrade operation

- Cluster: Solana Devnet, genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.
- Program 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5; ProgramData H5evLv9yEPaSRacNTYv5y4Tjdj3gJByUgavwMg66xTBg.
- Existing payer/upgrade authority 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A.
- Current deployed SHA256 fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489; replace with the reviewed ELF above.
- Seeded upload buffer 2HGHeWBCe1b5MDr4c4jwYocUKJ2WXfxzPkpi6o5eo2dV; temporary funding 3533957880 lamports (3.533957880 test SOL), returned to the same payer on successful upgrade.
- Upload at most 725 writes of 960-byte chunks, with fresh per-transaction simulation and fee 5000 lamports.
- ExtendProgram by 10240 bytes to ProgramData 699149; additional rent 52019200 lamports (0.0520192 test SOL).
- Estimated one-pass fees 3640000 lamports (0.003640 SOL); explicit total retry fee cap 50000000 lamports (0.05 SOL). Peak requirement with cap 3.635977080 SOL, maximum net rent plus fees 0.1020192 SOL.
- Existing user Safe B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu, ATA DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK, zero USDC, nonce 3 must remain byte-for-byte unchanged.

Extension and buffer creation simulate successfully, but a full upgrade cannot be simulated until the reviewed buffer is allocated and uploaded. That final simulation is mandatory before upgrade send. The bounded lifecycle sender pins the old/new hashes and padding, verifies all accounts and cost caps, journals signatures/wire before submission and stops on unresolved prior sends. Upload/extend/upgrade are a single expressly reviewed operation with the stated cap; no Mainnet action is included.

The new sender is web/scripts/v2-evm-lifecycle-upgrade-send.mjs. It requires --send-reviewed and V2_EVM_UPGRADE_ACK=APPROVED_DEVNET_EVM_LIFECYCLE_UPGRADE_4A2A. The protected existing signer is loaded only by the manual WSL operator process after authorization.

## Approval B: separate sponsor funding

- Cluster: Solana Devnet.
- From / fee payer: 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A.
- To / dedicated relayer: GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s.
- Amount: 50000000 lamports (0.05 test SOL); fee 5000 lamports (0.000005 SOL); rent 0.
- Unsigned simulation passed; no transfer sent.

web/scripts/v2-evm-relayer-funding-send.mjs requires --send-reviewed and V2_EVM_RELAYER_FUND_ACK=APPROVED_DEVNET_RELAYER_FUND_005_SOL. Existing journal prevents a blind second funding. Signed simulation and finalized balance deltas are checked. This transfer does not authorize automatic service sends or any owner action.

## Live-cycle sequence after both approvals

1. Verify deployed ELF hash, authority, empty existing Safe and buffer refund. Point the relayer at reviewed ELF size/hash and allow lifecycle; keep automatic=false. Permit only specifically approved manual jobs.
2. Human selects another EVM EOA (a Safe cannot be recreated for the already existing owner). Derive its Safe and ATA from address20 + program ID; add that public owner to the bounded sponsor allowlist. No Solana account or private key is derived from the EVM address.
3. Obtain fresh CreateSafe typed signature for nonce1 and the dedicated sponsor. POST /jobs simulates and returns planHash. Show exact Safe, ATA, mint, payer, rent and fee; obtain separate approval; use the local admin client for this exact job. Verify finalized creation and nonce1.
4. Prepare a small test-USDC deposit from the existing operator token account to that new ATA. Obtain separate deposit approval, send once and verify balances. Ordinary funding/CCTP remain disabled.
5. Sign a next-nonce withdrawal, then a cancellation at the same next nonce. Separately approve cancellation first; verify finalization and that the old withdrawal is rejected without token movement. Cancellation cannot reverse a withdrawal that executes first.
6. Obtain a fresh full-balance withdrawal intent at the new next nonce, approve the exact job, send through dedicated relayer, verify final balances and receipt.
7. Restart the service and verify its persisted finalized journal/status, replay rejection and no additional send. Check insufficient-budget/reserve rejection with temporarily stricter caps without intentionally burning fees to reach limits. The existing local suite covers unknown transport/restart and immutable saved-wire recovery; retain manual alternate-payer fallback.

The local operator client client/src/v2EvmRelayerOperator.ts supports --quote, --status, --approve. Approval requires the public digest, reviewed planHash and V2_EVM_RELAYER_SEND_ACK=APPROVED_DEVNET_JOB. The scoped submit token never approves a send. All private paths and credentials stay outside web/Git.

Mainnet upgrade, Production deployment, automatic budget authorization and upgrade-authority governance are separate later approvals.
