# Yield AI v2: EVM-owner Safe Devnet authorization probe

Status: source, Rust tests and isolated local-validator transaction cycle passed on 2026-09-28. Devnet deployment and live transactions have **not** been sent. This is a narrow authorization prototype. It does not enable deposits, swaps, Kamino, CCTP minting, or withdrawals from an EVM-owned Safe. Do not fund an EVM-owned Safe yet.

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

## Devnet test gates

1. Rust unit tests against a signature independently produced by `viem`: digest/recovery success, replay, expiry, wrong owner, wrong vault, modified allocation, high-s and invalid recovery byte. **PASS:** `NO_DNA=1 cargo test -p yield-vault --lib --features devnet --offline` (12/12). Default-feature regression: 9/9.
2. Build the Devnet binary and IDL with `NO_DNA=1 anchor build --provider.cluster devnet -- --features devnet`. **PASS:** IDL declares `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5`; the genesis constant matches the public Devnet RPC. Binary is 667,136 bytes; SHA-256 `ec3a33f0534caa36dea969eb140e5d881fca9ad55fee94f68535745737d33bb2`.
3. Local validator loaded the final binary and a disposable six-decimal test-USDC mint. `client/src/v2EvmOwnerProbe.ts --local` simulated and sent creation of the empty Safe and the allocation action; read-back showed nonce 1 and `[5000,0,0,0,0,0,0,0]`, and replay simulation failed. A second run sent no transactions and verified the same state. **PASS.** The final local-only signatures were `51KFkwFkgiAKw3abTePjLwoKMnRBkrrci7YztzND9BEejnTNZjHh8S3yBZdofJ4i8h5TZACWaLn2hiS4GbRbiYPn` and `3TGhYEc3SPZiDQTYKfBMmLvcgAE3pbxmQ51A9Pp7hpvAQGzEEUhbv7rbXGQabQgANMrEqDgfUAei2QXBQT9fQntu`; these are **not Devnet** transactions. Create used 41,447 CU in local simulation and a 5,000-lamport fee.
4. Devnet preflight, read-only: existing ProgramData `H5evLv9yEPaSRacNTYv5y4Tjdj3gJByUgavwMg66xTBg` has 630,000 bytes, authority `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, and 3.20127884 SOL rent balance. Payer/authority has 12.664628534 devnet SOL. Minimum 667,181-byte ProgramData rent is 3.38992972 SOL, an incremental ~0.18865088 SOL. Upload buffer rent is temporary. Empty Safe PDA `9hoSB5kdEpF3ECuZwoaEHHYXfadJ7r8VyG9eCiB86uU1` is absent; its canonical USDC ATA is `EoxX5dJzUgaUm72Fue9M4FK3QsDJ9arT5NDzRgMSDkUs`. Account rents are approximately 0.00423164 and 0.00148844 devnet SOL, plus network fees.
5. Obtain transaction-specific authorization, upgrade **Devnet only** with CLI preflight enabled, simulate each new instruction against Devnet, create an **empty** EVM Safe, submit a valid `evm_set_allocation`, then simulate a replay. Verify account nonce and allocation. Do not send a burn or USDC transfer.

Mainnet program `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` is not changed by the Devnet test. This prototype must not be included in a Mainnet upgrade until the owner can recover all assets, executor policy covers every movement, and a separate security review passes.
