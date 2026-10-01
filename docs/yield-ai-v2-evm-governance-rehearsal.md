# Squads v4 Devnet governance rehearsal — 2026-10-01

The user selected ordinary Solana wallets for governance and a one-hour Devnet timelock. Squads v4 implements the multisig and delay. The EVM personal Safe owner flow is separate.

The multisig creation [finalized at slot 506231328](https://explorer.solana.com/tx/2uHbhTrBTKNC2gjNKk2oihrbi8qKK66rfUeCQ9aw8DQ7JpY4B2rJuQhk8Nx8k3NwyCE1ogoNMc5qoiM2fRpAehte?cluster=devnet). Independent public-only verification decoded the on-chain multisig, rebuilt the exact creation instruction and checked receipt accounts/data, fee/debit, program hashes and unchanged Yield AI upgrade authority. See [preflight](yield-ai-v2-evm-governance-create-preflight.json) and [finalized receipt](yield-ai-v2-evm-governance-create-result.json).

| Setting | Verified value |
| --- | --- |
| Cluster | Solana Devnet |
| Squads v4 program | SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf |
| Multisig config | GGLdf4MtQkT98QoaDLyadrsn9rcEzRw1BxhaAkvvPN5r |
| Vault index 0 | JD59fdFqhchEt4CBFw9QKhXYeUvoeA5tAJ6kRWELPVDk |
| Threshold | 2 of 3 |
| Timelock | 3600 seconds, after threshold approval |
| External config authority | None: default public key |
| Permissions | Each selected member can initiate, vote and execute |
| Current proposal index at creation | 0 |
| Yield AI upgrade authority | Still 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A |

Members are 5m14KnDtidRfBXqETVRCWbNQJNPy8sxxhviaTqkf51XQ, EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2 and 4HfKpcmwZoF2u1ZVmHBJ6496y8VjNZGTHpJQTLQZ2E4B. The dedicated relayer is excluded. The operator paid 1823720 lamports rent and 10000 lamports fee, creation fee 0, total 1833720 (0.00183372 test SOL). These are governance operator expenses, separate from the service spending budget.

## Wallet steps

Use the [official Squads Backup UI](https://backup.app.squads.so/); [Squads documents this fallback](https://docs.squads.so/main/additional-resources/what-if-the-squads-app-goes-down). Its source defaults to Mainnet RPC, so set Settings -> RPC Url to https://api.devnet.solana.com before loading or signing anything. Program ID must be SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf.

1. Enter Multisig Config Address GGLdf4MtQkT98QoaDLyadrsn9rcEzRw1BxhaAkvvPN5r and click Set Multisig. Connect one selected Solana member; the connected wallet needs test SOL for proposal rent/fees.
2. Choose vault index 0. Use Import Transaction and paste unsignedMessageBase58 from [the prepared public message](yield-ai-v2-evm-governance-rehearsal-message.json). Review the single Memo program instruction: Yield AI Devnet governance rehearsal: 2of3,3600s. Amount moved is 0. Do not import an upgrade, authority transfer, asset transfer or other instruction for this rehearsal.
3. Import/sign the proposal, then approve with one member. Send its proposal index/link for independent readback and unsigned execution simulation. One approval must not permit execution.
4. Connect a different selected member and approve that same proposal. Send the link again. The second vote starts the one-hour delay; early execution must fail.
5. After the chain timestamp reaches threshold approval time + 3600 seconds, run the fresh execution preflight and execute through a selected member. Verify the finalized receipt and reject replay.

The prepared Memo requires the Squads vault PDA signature and tests that the program can authorize that vault. It needs no vault funding and transfers no asset. A live-program unsigned simulation created the proposal and first vote in projected state only: Active with exactly one approval. It sent no transaction, read no signer file and created no account. The simulation used the operator as projected rent/fee payer; the actual UI uses the connected member wallet. This is preparation evidence, not a human vote or completed timelock cycle.

## Verification commands

From client with Node/tsx installed for the execution OS:

~~~text
node --import tsx --test scripts/v2-evm-governance.test.mjs
node node_modules/typescript/bin/tsc --noEmit
node --import tsx src/v2EvmGovernanceCreate.ts --verify 2uHbhTrBTKNC2gjNKk2oihrbi8qKK66rfUeCQ9aw8DQ7JpY4B2rJuQhk8Nx8k3NwyCE1ogoNMc5qoiM2fRpAehte
node --import tsx src/v2EvmGovernanceProposal.ts --message
node --import tsx src/v2EvmGovernanceProposal.ts <actual-proposal-index>
~~~

Ten policy tests passed: valid SDK account/PDA, threshold downgrade, absent/wrong timelock, external config authority, extra/duplicate/unexpected members, relayer membership, missing vote permission, wrong owner/PDA/discriminator and truncation. TypeScript passed. Proposal verification strictly binds the reviewed Memo, vault/index, member votes, current config and Solana Clock, then simulates execution for one-vote rejection, early timelock rejection, elapsed-delay readiness or replay rejection. Later public proof files are produced only after the actual corresponding state exists.

The create CLI is a protected WSL operator tool. It pins the verified preflight, simulates signed bytes, durably reserves the exact signature/wire before RPC and refuses any send when a prior journal exists. An initial signing attempt failed before journal/RPC because of temporary-buffer aliasing; it debited no funds. Copy-before-zeroization was fixed and the successful transaction passed signature-verified simulation. Two large WSL RPC readbacks were interrupted; public-only Windows readback completed successfully. These failures did not trigger duplicate sends.

## EVM intent cancellation rehearsal

The separately prepared cancellation verifier recorded [the prior Safe snapshot](yield-ai-v2-evm-cancel-before.json): nonce 2, zero USDC, sponsor 44269920 lamports. The owner must sign a harmless allocation target and a cancellation at the same next nonce 3, submit only cancellation and provide the unsubmitted allocation before its expiry.

~~~text
node --import tsx src/v2EvmCancelRehearsal.ts --snapshot
node --import tsx src/v2EvmCancelRehearsal.ts --verify-stdin
~~~

Verification stdin is a private in-process object with staleIntent and cancelTx. Do not save owner signatures in public docs or Git. The verifier requires valid unexpired signatures, a finalized exact cancellation receipt, nonce 2 -> 3, unchanged Safe/ATA except nonce, 5000-lamport dedicated sponsor fee, public finalized relayer status, on-chain InvalidNonce for stale allocation/cancel replay, and API 409 for both. These probes submit no transaction. The cancel-wins ordering cannot undo an action that executes first.

## Remaining gates

No human cancellation or governance votes have yet been received at this checkpoint. No one-hour execution test or authority transfer has occurred. The standalone multisig timelock is configured on-chain; it does not protect Yield AI upgrades while Yield AI still names the single operator authority. Transfer only after the selected wallets demonstrate voting, delayed execution and recovery of that vault; re-read binary/authority and prepare the exact transfer and future upgrade path.

The one-hour setting is the user's Devnet rehearsal choice. The previous 48-hour Mainnet proposal remains unactivated and needs a separate decision. Mainnet transactions and Production deployment require separate authorization. Ordinary Safe funding/CCTP, yield custody and Safe close/rent refunds remain gated.
