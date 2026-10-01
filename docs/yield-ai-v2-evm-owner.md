# Yield AI v2: EVM-owner Safe Devnet authorization probe

Current 2026-10-01 implementation and gates: [signed lifecycle, recovery fallback and dedicated relayer](yield-ai-v2-evm-lifecycle-relayer.md). New lifecycle code is tested locally, not deployed. The separate sponsor remains send-disabled and unfunded. Full live recovery finalized: Safe 0 USDC, nonce 3; recipient now 1 USDC. See [full recovery receipt](yield-ai-v2-evm-full-recovery-result.md). Historical receipts below retain their original observations.

Status: Rust tests and isolated local-validator transaction cycle passed on 2026-09-28. The Devnet program was upgraded on 2026-09-29 and its deployed ELF hash was verified. An empty EVM-owner Safe was created on Devnet and its first EIP-712 allocation action succeeded. The separate `/v2/evm-devnet` lab lets a user sign an allocation intent with an EVM wallet; an operator can relay that intent after simulation and separate transaction authorization. This is a narrow authorization prototype. The 2026-09-30 separately approved upgrade now adds owner-authorized idle-USDC withdrawal. Its deployed hash is verified. On 2026-10-01 a human Rabby signing cycle completed a 1-USDC deposit and a 0.1-USDC owner-authorized withdrawal; Full-balance recovery subsequently finalized: Safe 0 USDC, nonce 3; recipient 1 USDC. Ordinary funding, swaps, Kamino and CCTP remain disabled.

## Human-signed Devnet withdrawal (2026-10-01)

A fresh Rabby EIP-712 intent and separate send approval produced a finalized 0.1 test-USDC withdrawal to the owner-selected Solana wallet EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2. Receipt and independent readback confirm Safe 1 -> 0.9 USDC, recipient 0 -> 0.1 USDC, nonce 1 -> 2. See [withdrawal receipt](yield-ai-v2-evm-withdraw-result.md). Full-balance recovery subsequently finalized ([receipt](yield-ai-v2-evm-full-recovery-result.md)); ordinary funding/CCTP remain disabled.

## Manual Devnet recovery deposit (2026-10-01)

The user-approved 1 test-USDC deposit is finalized and balance-verified. Safe balance is 1000000 raw (1 USDC), nonce remains 1; operator balance is 19 USDC. See [deposit receipt](yield-ai-v2-evm-deposit-result.md). Owner-signed withdrawal remains pending, so ordinary funding/CCTP remain disabled.

## Local withdrawal implementation (2026-09-30)

Owner-authorized idle-USDC withdrawal is now implemented and validated locally in this EVM worktree. The separately approved Devnet withdrawal upgrade is finalized and its ELF hash verified. Keep ordinary funding disabled until the separately reviewed manual recovery cycle. See [upgrade receipts and cost reconciliation](yield-ai-v2-evm-upgrade-result.md). See [withdrawal payload, tests and local receipts](yield-ai-v2-evm-withdrawal.md). The historical Devnet results below are unchanged.

## Why this is a separate account

The existing `Vault` remains owned by a Solana public key and keeps its serialized layout and PDA seeds `['vault', owner32]`. `EvmVault` has its own Anchor discriminator and PDA seeds `['vault_evm', ethAddress20]`. It records the 20-byte EVM address, rent payer, nonce, agent (initially zero), allocation, and reserved route state. Existing Solana-owner instructions require a `Vault` account and its original seeds, so they cannot authorize an `EvmVault`.

`create_evm_safe` is sponsored: any Solana payer can create the empty PDA and its canonical USDC ATA. It records the first payer for future rent accounting. It does **not** prove ownership of the EVM address, so a first-creation race is possible; neither claimant can set allocation without that address's EIP-712 signature. Before funding or implementing close/refunds, decide whether creation needs an owner-signed intent and how to handle a third-party sponsor.

## First signed action

`evm_set_allocation(allocationBps: u16[8], nonce: u64, deadline: u64, signature: [u8;65])` changes only target allocation. The relayer is the Solana transaction fee payer; the EVM address is verified inside the program by `secp256k1_recover`. The signed values bind the Solana genesis hash, exact EVM Safe PDA, all eight route percentages, next nonce and deadline. A valid signature from a different Safe, cluster, or program is rejected. A second use of the same nonce is rejected.

EIP-712 domain:

```text
name:    Yield AI Safe
version: 1
salt:    bytes32(Solana program ID)
```

EIP-712 primary type and field order:

```text
SetAllocation(
  bytes32 genesisHash,
  bytes32 vault,
  uint16[8] allocationBps,
  uint64 nonce,
  uint64 deadline
)
```

`vault` is the raw 32 bytes of the PDA, `genesisHash` is the 32-byte decoding of the cluster's base58 genesis hash, and `deadline` is Unix seconds. The exact domain/type strings, array hashing and values are in `programs/yield-vault/src/evm_owner.rs`. Wallets should be asked to sign the typed data as is; never sign an opaque digest in the UI. The program accepts recovery byte `0/1` or `27/28`, and requires low-s signatures.

This EIP-712 domain separates this Solana program from other signing applications, and the message binds the Devnet genesis, Safe, action, nonce and expiry. It does **not** contain a website hostname or browser origin. A different website could request the same typed message; the wallet UI should show the requesting origin and exact typed fields. Do not describe the signature as tied to a particular web domain. Future custody actions need their own explicit typed payload and security review before EVM-owner funds can move.

## Devnet test gates

1. Rust unit tests against a signature independently produced by `viem`: digest/recovery success, replay, expiry, wrong owner, wrong vault, modified allocation, high-s and invalid recovery byte. **PASS:** `NO_DNA=1 cargo test -p yield-vault --lib --features devnet --offline` (12/12). Default-feature regression: 9/9.
2. Build the Devnet binary and IDL with `NO_DNA=1 anchor build --provider.cluster devnet -- --features devnet`. **PASS:** IDL declares `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5`; the genesis constant matches the public Devnet RPC. Binary is 667,136 bytes; SHA-256 `ec3a33f0534caa36dea969eb140e5d881fca9ad55fee94f68535745737d33bb2`.
3. Local validator loaded the final binary and a disposable six-decimal test-USDC mint. `client/src/v2EvmOwnerProbe.ts --local` simulated and sent creation of the empty Safe and the allocation action; read-back showed nonce 1 and `[5000,0,0,0,0,0,0,0]`, and replay simulation failed. A second run sent no transactions and verified the same state. **PASS.** The final local-only signatures were `51KFkwFkgiAKw3abTePjLwoKMnRBkrrci7YztzND9BEejnTNZjHh8S3yBZdofJ4i8h5TZACWaLn2hiS4GbRbiYPn` and `3TGhYEc3SPZiDQTYKfBMmLvcgAE3pbxmQ51A9Pp7hpvAQGzEEUhbv7rbXGQabQgANMrEqDgfUAei2QXBQT9fQntu`; these are **not Devnet** transactions. Create used 41,447 CU in local simulation and a 5,000-lamport fee.
4. Devnet preflight, read-only: before the upgrade, ProgramData `H5evLv9yEPaSRacNTYv5y4Tjdj3gJByUgavwMg66xTBg` had 630,000 bytes, authority `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, and 3.20127884 test SOL rent balance. Payer/authority had 12.664628534 test SOL. Minimum 667,181-byte ProgramData rent is 3.38992972 test SOL, an incremental 0.18865088 test SOL. Empty Safe PDA `9hoSB5kdEpF3ECuZwoaEHHYXfadJ7r8VyG9eCiB86uU1` is absent; its canonical USDC ATA is `EoxX5dJzUgaUm72Fue9M4FK3QsDJ9arT5NDzRgMSDkUs`. Account rents are approximately 0.00423164 and 0.00148844 test SOL, plus network fees.
5. **PASS, Devnet upgrade:** the first attempt failed on the public Devnet RPC without changing on-chain state. A retry extended ProgramData and created an incomplete temporary buffer, but did not replace the ELF; that RPC then returned HTTP 429. The final CLI deployment used a Helius Devnet endpoint whose genesis hash was independently checked, with preflight enabled. [Upgrade transaction](https://explorer.solana.com/tx/UmUkbttz6igwHN9ZfrhpLVkLt8XvLDmJ9wtH49pLuPQo46WmAsi7TB2Yb6nYrc95wB1pCc4C6voqWyLeEiV3YKe?cluster=devnet) is finalized at slot 505600165, with no error and a 5,000-lamport fee. ProgramData is 667,181 bytes, rent balance 3.38992972 test SOL, and the deployed 667,136-byte ELF SHA-256 exactly matches `ec3a33f0534caa36dea969eb140e5d881fca9ad55fee94f68535745737d33bb2`. Program `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5` is executable. No Mainnet program or USDC was touched.
6. **PASS, buffer cleanup:** the incomplete buffer `AC3pc9HvXzsGFsWscaYqirmM3oFVjFh6MZX5fZ4xBYZj` held 3.38992972 test SOL. An unsigned `Close` simulation succeeded (2,370 CU, estimated 5,000-lamport fee). After separate authorization, [the close transaction](https://explorer.solana.com/tx/3Wpb7HjN5UteU216spCcxHLs5N7Z5mMvW9k97bfYKhYZtDopBfjjXPeozReozmV3LjGYxqu8cJpFKZYUGpzw7ckg?cluster=devnet) finalized at slot 505608596. The buffer is absent and the payer balance increased from 9.082482934 to 12.472407654 test SOL, exactly 3.38992972 minus the 0.000005 SOL fee.
7. **PASS, unsigned Devnet preflight:** `client/src/v2EvmOwnerProbe.ts --preflight-devnet` uses a configurable Devnet RPC and no payer keypair. It checked the genesis hash, confirmed the fixture Safe was absent, and simulated `create_evm_safe` followed by `evm_set_allocation` in one transaction: error `null`, 65,462 CU, estimated 5,000-lamport combined fee, and 5,720,080 lamports of Safe plus ATA rent. This did not create accounts.
8. **PASS, live Devnet authorization probe:** after separate authorization, [`create_evm_safe`](https://explorer.solana.com/tx/2QJxwYBYhbfro3E9XwPksEm3S8ZkJA5GYtFYGXxtrJTTE5wkCXnspqQrmwjUXM19KoT3rcdYEN8SQcPTrHaBh5wv?cluster=devnet) finalized at slot 505625743 (34,212 CU; 5,000 lamports fee), then [`evm_set_allocation`](https://explorer.solana.com/tx/T4WGFVn1rm1Dx5Rjni6cchMcSH9HRKLKhUKm4g6fzwrV4HvKZT4DMYZsNLtA1hXXiExx8XyLxcq6B9Fo9cMiabm?cluster=devnet) finalized at slot 505625756 (31,250 CU; 5,000 lamports fee). Independent finalized RPC reads found Safe `9hoSB5kdEpF3ECuZwoaEHHYXfadJ7r8VyG9eCiB86uU1` owned by the Devnet program, fixture EVM owner `0xd7bd5acfd8b726ccc99ad8d71983293638185619`, rent payer `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, nonce `1`, allocation `[5000,0,0,0,0,0,0,0]`, and canonical test-USDC ATA `EoxX5dJzUgaUm72Fue9M4FK3QsDJ9arT5NDzRgMSDkUs` with amount `0`. Replay simulation rejected the same signature. Total payer balance decreased by 5,730,080 lamports: 5,720,080 rent plus 10,000 in transaction fees. This fixture does not represent the user's MetaMask account, and no USDC was transferred. The web UI still supports only the Solana-owner Safe.

9. **PASS, user EVM wallet via the Devnet lab:** EVM owner `0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B` signed the `SetAllocation` intent for Safe `B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu`, nonce `1`, allocation `[5000,0,0,0,0,0,0,0]`. A refreshed signature was simulated successfully (74,460 CU) and relayed after transaction-specific approval. [The atomic creation and allocation transaction](https://explorer.solana.com/tx/4rADgMQso9Mgj2iyrGCTNAM3GVFVJRDyAEXikyjytVwnzKTtvCh6KueQ5VnKrYB8DVEENhQSJxMejXoCX5oGWLAa?cluster=devnet) finalized at slot 505789279 with status `Ok`. The operator CLI read back nonce `1` and allocation `50%` on route 0. Independent RPC receipt showed 5,000 lamports transaction fee and payer balance `12.466677574 -> 12.460952494` test SOL: 5,720,080 lamports of Safe plus ATA rent and 5,000 lamports fee. The canonical test-USDC ATA is `DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK`. No USDC moved. This proves wallet EIP-712 authorization and sponsored Devnet setup, not owner-authorized custody or withdrawal.

Mainnet program `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` is not changed by the Devnet test. This prototype must not be included in a Mainnet upgrade until the owner can recover all assets, executor policy covers every movement, and a separate security review passes.

## EVM wallet lab and operator relay

The `/v2/evm-devnet` page uses EIP-6963 wallet discovery and EIP-1193 requests. A user chooses an EVM account in MetaMask, Rabby, or another compatible wallet. The page derives `EvmVault` and the canonical test-USDC ATA from that **EVM address**; no MetaMask Solana account is requested. It reads Solana Devnet state through `/api/v2/evm-devnet` and offers an allocation target from 0% to 100% for route 0 (Kamino). Other routes remain zero. The user signs EIP-712 typed data with a ten-minute deadline. The browser and server verify the signature, owner, PDA, nonce, cluster and payload. The page then displays a copyable public signed request. Signing and POST verification do **not** create the Safe or send a Solana transaction.

For this first version, relay is an operator action, not an automatic web endpoint. The operator saves the copied JSON to a local file and runs `client/src/v2EvmOwnerRelay.ts --preflight <intent.json>` with a protected existing Devnet payer keypair configured through `V2_PAYER_KEYPAIR`. The CLI checks the Devnet genesis, expected payer address, PDA, nonce, deadline, fee/rent caps and full transaction simulation. If the Safe does not exist, it simulates `create_evm_safe` and `evm_set_allocation` atomically. If it exists, it simulates only the allocation action. `--send` additionally requires `V2_EVM_RELAY_ACK=APPROVED_DEVNET_EVM_INTENT` and **separate transaction-specific authorization**; it must not be run merely because the user copied a signature. A successful relay reads back the new nonce and allocation. Request a fresh signature if the nonce or deadline changes.

`V2_EVM_DEVNET_RPC_URL` is optional and **server-only** for the web read/verify API. `V2_DEVNET_RPC_URL` is optional for the operator CLI. Both default to the public Devnet RPC, and both must point to Devnet; the code checks the genesis. Never put an RPC secret, payer keypair, or Mainnet upgrade authority in `NEXT_PUBLIC_*` or on Vercel. For the current manual lab, the protected payer key stays on the operator machine. A dedicated low-balance Devnet sponsor key is the next step before any unattended relayer.

An ephemeral EVM account was used to exercise the operator CLI without transmitting a transaction. The signed intent derived Safe `35aAjNvpm614YMJqpkYqe5gfBD9RJs7tZAwFL7EAy4sN`; `--preflight` returned `simulation_ok`, 71,462 CU, 5,720,080 lamports rent and 5,000 lamports estimated network fee for atomic creation plus allocation. The ephemeral private key was kept in process memory and was not saved. A local HTTP check returned 200 for the lab page, read the existing Devnet fixture at nonce 1 with 0 test USDC, accepted a fresh ephemeral EIP-712 POST, and rejected a tampered allocation with the same signature. `npm run build` passed after public RPC 429 retries during unrelated static page generation; the new page and API are in the route list. This does not establish that a user's wallet can sign in the browser; that remains a separate gate.

Test sequence: open the Devnet lab Preview; connect the intended EVM account; inspect the displayed EVM address, Safe and ATA; sign the displayed typed allocation request; copy the verified JSON to the operator; run read-only preflight; review the exact Safe, target, rent and fee; obtain authorization for that particular Devnet transaction; send once; refresh the page and confirm nonce/allocation on chain. **Do not send test or real USDC to this Safe.** The Mainnet program and `/v2/safe` Solana-owner flow are separate.
