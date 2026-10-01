# Human EVM-owner recovery through the dedicated Devnet relayer — 2026-10-01

The new human EVM owner completed creation, a 1-test-USDC deposit and full owner-authorized withdrawal. The owner signed in Rabby and submitted through the lab. The dedicated automatic relayer paid creation rent and withdrawal fees; only the deposit used the protected manual operator. No Mainnet transaction or Production deployment occurred.

| Step | Finalized slot | Safe USDC | Safe nonce | Transaction |
| --- | --- | --- | --- | --- |
| Owner-signed creation | 506217071 | 0 | 1 | [Creation](https://explorer.solana.com/tx/2ShNecBfiDZMDW8NUKN1mAJFHkTUW71RDuyMzWQ8s9T4hzWBaLXFBCnAaCLk4ABKrVkD8Gyo1bLxiJrEyrnBoXtJ?cluster=devnet) |
| Manual 1-test-USDC deposit | 506220470 | 0 -> 1 | 1 | [Deposit](https://explorer.solana.com/tx/BtUy3B6j93QfMiDERUqo1FrtdWZXyKbtAWq95R39gUui5GauLH5ehknodb538KA1LY8XFGvxh3WdBL9wZg3DeGD?cluster=devnet) |
| Owner-signed full withdrawal | 506221649 | 1 -> 0 | 1 -> 2 | [Withdrawal](https://explorer.solana.com/tx/4REERRgW9v2E6Dm79RLfCzrdrUEV9a6FqVW9xFncJhwsv96j8UnKCuw4xWwTGdnUypoABp9SmRf265h6XHn5onAW?cluster=devnet) |

Owner: 0xb659DA13418527601C52D4220536C12397F20855. Safe: bn4KYuYg6fvbqPEh13rC1Exr5HuPCC455KiC1dTEnEr. Safe test-USDC ATA: rQUE1MGE7jwzyCoUdWTphYKP28hjU3QqcnMjnGCwLxm. Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU, 6 decimals.

The exact withdrawal was 1000000 raw to ATA eLJeneXAJnyyBanwkQ64JZGaZLGmkVP4x92JBEhzSyw, owned by the explicitly selected Solana recipient EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2. Recipient balance changed 1 -> 2 USDC. The intent used nonce 2, deadline 1790846411, program 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5 and Devnet genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.

Independent finalized RPC verification checked the exact withdrawal instruction, amount, recipient, token deltas, Safe state/nonce and fee payer. The deployed ELF hash still matches 4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98. The public relay status independently agrees: finalized, the same signature/slot, and actual cost 5000 lamports. Verification read no signer file.

Dedicated sponsor GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s paid 5000 lamports (0.000005 test SOL), rent 0, for withdrawal. Its balance changed 44274920 -> 44269920 lamports. Creation plus withdrawal consumed 5730080 lamports including creation rent. The manual operator's separate 5000-lamport deposit fee is outside service accounting. Safe/ATA remain open; no rent refund occurred.

Public evidence: [creation](yield-ai-v2-evm-human-creation-result.json), [deposit preflight](yield-ai-v2-evm-new-owner-deposit-preflight.json), [deposit receipt](yield-ai-v2-evm-new-owner-deposit-result.json), [independent withdrawal and relayer receipt](yield-ai-v2-evm-new-owner-withdraw-result.json). Public evidence contains no private keys, RPC credentials, wallet signature or signed transaction bytes.

This proves the human-wallet creation/deposit/full-withdrawal path on Devnet through the dedicated service. A live cancellation race with a competing pending intent has not been performed; cancellation and journal restart have local SBF/test evidence. Ordinary funding/CCTP, yield custody, Safe close/refunds and Mainnet rollout remain gated. Upgrade authority remains a single signer; proposed multisig/timelock governance is not active.
