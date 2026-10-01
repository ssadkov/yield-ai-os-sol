# Devnet full owner recovery — 2026-10-01

Status: finalized and independently verified after fresh EVM-owner signature and separate user approval for this exact operation.

Transaction: [rA7azNw6fdL966bAxso9J24f7CDEtqCHJFt2oF4KiAyvEyn4EAvjY8hZhKSeXA7YPC41bQvjJzcP9waX8qCsPS4](https://explorer.solana.com/tx/rA7azNw6fdL966bAxso9J24f7CDEtqCHJFt2oF4KiAyvEyn4EAvjY8hZhKSeXA7YPC41bQvjJzcP9waX8qCsPS4?cluster=devnet). Finalized slot 506169976, block time 2026-10-01T05:48:37.000Z.

- Program: 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5; deployed ELF SHA256 fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489.
- Owner: 0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B; Safe B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu.
- Test-USDC mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU; amount 900000 raw (0.9 USDC).
- Source: DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK; balance 900000 -> 0 raw.
- Recipient wallet: EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2; token account eLJeneXAJnyyBanwkQ64JZGaZLGmkVP4x92JBEhzSyw.
- Recipient balance: 100000 -> 1000000 raw (0.1 -> 1 USDC).
- Safe nonce: 2 -> 3.
- Fee payer: 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A; fee 5000 lamports, rent 0.
- EIP-712 digest: 0x5d451fd2faf076012674f863626341923b375ffca285f0bb9bb83da41d54e023; deadline 1790833798.

Unsigned preflight and fresh send-mode simulation both passed (41725 CU). Independent finalized receipt and account readback confirmed exact token deltas, EVM owner, nonce, payer debit and deployed program hash. The original 1-USDC manual deposit has now been fully recovered by two owner-authorized withdrawals (0.1 + 0.9 USDC).

This validates idle-USDC recovery through the manual operator CLI on the deployed withdrawal binary. It does not deploy the pending signed-creation/cancellation binary, activate automatic relayer sends, transfer upgrade authority or enable CCTP. Ordinary funding/CCTP remain disabled pending those gates. Safe and its ATA remain open; no rent refund was performed. Mainnet and Production were not changed.

[Machine-readable verification](yield-ai-v2-evm-full-recovery-result.json).
