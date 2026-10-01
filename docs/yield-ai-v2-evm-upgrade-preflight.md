# Devnet EVM-owner withdrawal upgrade: approval packet

Execution update: this historical preflight packet was separately approved and the upgrade finalized. See [execution receipts and verified result](yield-ai-v2-evm-upgrade-result.md). The pre-upgrade observations and proposed budget below are preserved.

Status: 2026-09-30, read-only preflight complete. No public transaction has been signed or sent. This packet requests approval only for upgrading the existing Devnet program with the locally validated owner-authorized USDC withdrawal binary. It does not authorize a deposit, an owner withdrawal, Mainnet upgrade, Production deployment, or a service relayer.

## Reviewed operation and addresses

- Cluster: Devnet; live genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.
- Program: 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5.
- ProgramData: H5evLv9yEPaSRacNTYv5y4Tjdj3gJByUgavwMg66xTBg.
- Current upgrade authority, fee/rent payer and buffer-rent refund recipient: 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A.
- Proposed temporary buffer: HWZmWntMjPbMGUnFP2fh37kmGBuYD5ykx9RH23i8zPvp; seeded from the existing authority with public seed evm-wd-fee494161131-20260930. This address is absent on Devnet.
- New ELF: target/deploy/yield_vault.so; 688864 bytes; SHA-256 fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489.
- On-chain ELF: 667136 bytes; SHA-256 ec3a33f0534caa36dea969eb140e5d881fca9ad55fee94f68535745737d33bb2; last upgrade slot 505600165.
- Public rollback copy: target/deploy/yield_vault-devnet-before-withdraw.so, same old ELF hash. This is an ignored build artifact, not a private key. A rollback transaction would require its own approval.

Operation: fund one temporary loader buffer, upload exactly the reviewed ELF, extend ProgramData by 21728 bytes to 688909 bytes, simulate and upgrade the existing program, then verify finalized receipt, deployed bytes/hash, authority and unchanged Safe state. Temporary buffer authority is the same operator. Its reviewed address is derived using SystemProgram.createAccountWithSeed; creation needs only the existing operator signature and no new buffer private key. No buffer was created by this preflight. The exact seeded account creation was simulated with zero signatures.

## Live state and budget

Observed at 2026-09-30T18:25:38.390Z, finalized snapshot slot 505995099. All amounts below are test SOL, obtained from current Devnet RPC rent/fee responses, not from a static rent formula.

| Item | Lamports | Test SOL |
| --- | ---: | ---: |
| Payer balance | 12460952494 | 12.460952494 |
| Existing ProgramData balance | 3389929720 | 3.389929720 |
| Required ProgramData rent after extension | 3500307960 | 3.500307960 |
| Additional ProgramData rent | 110378240 | 0.110378240 |
| Temporary buffer funding, CLI-compatible | 3500307960 | 3.500307960 |
| Estimated upper bound for one upload pass, including extension/create/upgrade fees | 3605000 | 0.003605000 |
| Proposed total fee cap, including retries | 50000000 | 0.050000000 |
| Peak funding requirement with fee cap | 3660686200 | 3.660686200 |
| Maximum net SOL committed/spent after successful buffer refund, with fee cap | 160378240 | 0.160378240 |

The additional ProgramData rent remains in ProgramData. The temporary buffer funding returns to the reviewed payer on successful upgrade. If upload/upgrade fails, buffer rent may remain in that buffer: inspect it and report its address/balance; do not allocate another buffer or close the failed one without reviewing the next operation. No previous cleanup approval applies to a new buffer.

Buffer account size is 688901 bytes (37-byte metadata plus ELF); its own minimum rent is 3500267320 lamports. The reviewed seeded buffer uses the slightly larger CLI-compatible ProgramData-derived funding amount shown above. The conservative fee estimate uses 960 bytes per write, at most 718 writes and 5000 lamports per single-signature write, with zero priority price. Seeded create has one signature and an estimated 5000-lamport fee. Extension and final upgrade each budget 5000 lamports. The fee cap is a proposed approval limit, not an implemented automatic service policy. Use a single buffer and bounded attempts; report uncertain transaction status before retrying.

## Unsigned simulations and limitations

- Buffer creation plus InitializeBuffer: err=null, 2820 CU, estimated fee 5000 lamports. Simulation returned the expected 688901-byte buffer and funding; no buffer persists.
- ExtendProgram: err=null, 2820 CU, estimated fee 5000 lamports. Simulation returned 688909-byte ProgramData and exactly 110378240 additional rent.
- ExtendProgramChecked: InvalidInstructionData on this cluster. Use the successful legacy extension; recheck feature support immediately before sending. This was an unsigned negative simulation; no fee was charged.
- Final Upgrade: not simulated against public Devnet yet, because there is no funded/uploaded new buffer. After upload, compare buffer ELF hash and authority, then simulate the actual final upgrade before sending. Stop if it fails. Local SBF program execution and recovery tests already passed; that does not replace this final on-chain-state preflight.

The user's Safe remains B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu, USDC ATA DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK, owner 0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B, nonce 1, allocation [5000,0,0,0,0,0,0,0], balance 0 raw USDC. The mint is 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU, six decimals, original SPL Token program. No source delegate or close authority is present. The upgrade changes no Safe layout.

## Reproduce and subsequent manual test

From the EVM worktree:

~~~sh
node web/scripts/v2-evm-upgrade-preflight.mjs
~~~

The script only allows read RPC and unsigned simulateTransaction; it does not open wallet files or expose the RPC URL. It pins both reviewed ELF hashes and validates program/ProgramData ownership, pointer, authority, Safe discriminator/layout, owner, canonical ATA and mint. Re-run immediately before any approved operation and stop for review if these facts change. Detailed public result: [preflight JSON](yield-ai-v2-evm-upgrade-preflight.json).

After the upgrade is independently verified, choose the user's Solana receiving wallet and existing Devnet USDC token account. Enable only the withdrawal-signing lab gate locally, check MetaMask/Rabby connection and error handling manually, re-read Safe nonce, and request a fresh WithdrawUsdc intent for that exact recipient and raw amount. Obtain separate transaction-specific authorization for a minimal test-USDC deposit and for its owner-authorized withdrawal after simulation. Normal funding/CCTP stays disabled until recovery is confirmed. No Solana address is derived from the EVM address.

Local implementation and security evidence: [withdrawal report](yield-ai-v2-evm-withdrawal.md). The main checkout and Solana API files are untouched; the EVM worktree remains based on bbc23fb with uncommitted local changes. This binary is not a merged build of parallel Solana API development.

Loader sizing/CLI behavior was checked against the installed loader-v3 interface and [Agave 3.1.12 CLI source](https://github.com/anza-xyz/agave/blob/v3.1.12/cli/src/program.rs); upgrade/extension behavior is also described in [Solana deployment documentation](https://solana.com/docs/programs/deploying).
