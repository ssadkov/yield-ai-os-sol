# EVM Safe: approved Devnet recovery deposit

Executed on 2026-10-01 at 01:03 Asia/Qyzylorda (2026-09-30T20:03:23.701Z UTC), following the user's explicit approval to increase the deposit from 0.1 to 1 test USDC.

- Cluster: Solana Devnet; genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.
- Action: SPL Token transfer_checked, mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU, decimals 6.
- Operator / fee payer: 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A.
- Source USDC account: GfSmEbCHJ9qsYLUcSL8aedFmnQKAC1cq54MWYYbnx5Un; balance 20 -> 19 test USDC.
- EVM owner: 0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B.
- Safe: B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu.
- Destination USDC account: DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK; balance 0 -> 1 test USDC.
- Amount: 1.000000 test USDC = 1000000 raw units.
- Unsigned and signature-verified simulations passed; no rent required.
- Signature: 2f7JqsinT7frq4ipwXZwffoReZVQsKTSgfMwAwMLF3zw455dSpYBWRCZnF8bDrfyEZpJn5DzxuaYyCvkrMnFfx4t.
- Finalized slot: 506020124; readback slot: 506020132.
- Actual fee: 5000 lamports = 0.000005 test SOL; rent: 0.
- Safe data unchanged; nonce remains 1.

The existing protected operator signer was used only in the local operator process, without exposing or copying its key. The public receipt is in [deposit-result.json](yield-ai-v2-evm-deposit-result.json). A local signature journal prevents automatic repeat deposits. Main checkout, mobile Solana API, and web signer configuration were untouched.

Owner recovery is still pending. For a full test return to the operator, the user can sign a new WithdrawUsdc intent for 1 USDC to receiving wallet 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A, whose canonical test-USDC account is GfSmEbCHJ9qsYLUcSL8aedFmnQKAC1cq54MWYYbnx5Un. Read fresh state first; if nonce remains 1, the intent nonce is 2. Withdrawal needs its own signed intent, simulation and separate send approval. Ordinary funding/CCTP remain disabled.
