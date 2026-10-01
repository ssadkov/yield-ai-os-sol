# New human EVM Safe recovery deposit — Devnet

[1 test-USDC deposit](https://explorer.solana.com/tx/BtUy3B6j93QfMiDERUqo1FrtdWZXyKbtAWq95R39gUui5GauLH5ehknodb538KA1LY8XFGvxh3WdBL9wZg3DeGD?cluster=devnet) finalized at slot 506220470. Independent finalized receipt validates exactly one SPL Token TransferChecked instruction, amount 1000000 raw, decimals 6, exact source/destination and token-balance deltas. See [public receipt and withdrawal readiness](yield-ai-v2-evm-new-owner-deposit-result.json).

- EVM owner 0xb659DA13418527601C52D4220536C12397F20855; Safe bn4KYuYg6fvbqPEh13rC1Exr5HuPCC455KiC1dTEnEr.
- Mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU; destination ATA rQUE1MGE7jwzyCoUdWTphYKP28hjU3QqcnMjnGCwLxm.
- Existing manual operator source GfSmEbCHJ9qsYLUcSL8aedFmnQKAC1cq54MWYYbnx5Un: 19000000 -> 18000000 raw.
- Safe ATA: 0 -> 1000000 raw (1 USDC). Safe bytes unchanged, nonce 1.
- Manual operator and fee payer 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A; fee 5000 lamports, rent 0. This operator source signer was loaded only by the protected local WSL deposit process, never by the web or dedicated relayer service.
- Deployed lifecycle ELF hash/padding, Safe owner/layout/sponsor, mint, source/destination authority/state and fee cap were checked before unsigned and signed simulations. An exact signed wire/signature was journaled and fsynced before RPC submission. Existing journal blocks a blind second deposit; uncertainty never creates another transaction. Public receipts exclude wire and keys.

The next withdrawal requires a fresh EIP-712 signature from this EVM owner. Current next nonce 2, amount 1000000 raw (1 USDC). The previously user-selected test Solana recipient EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2 has valid ATA eLJeneXAJnyyBanwkQ64JZGaZLGmkVP4x92JBEhzSyw holding 1000000 raw before this proposed withdrawal. The owner must review and sign the exact destination; no withdrawal signature has yet been received at this checkpoint. Sign on the lab page and submit to the bounded dedicated relayer. Re-read live nonce and balances before signing.

The owner subsequently signed and submitted the full 1-USDC withdrawal, which finalized through the dedicated relayer: Safe 0 USDC, nonce 2; recipient 2 USDC. See [completed recovery cycle](yield-ai-v2-evm-new-owner-withdraw-result.md). The preceding paragraph is the historical deposit/signing checkpoint. Live cancellation of a competing pending intent remains unperformed. Ordinary funding/CCTP, Mainnet rollout and Safe close/refunds remain disabled.
