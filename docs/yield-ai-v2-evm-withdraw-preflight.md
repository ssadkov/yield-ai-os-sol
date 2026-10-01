# First human-signed EVM Safe withdrawal preflight

Read-only check on 2026-10-01, Asia/Qyzylorda. No transaction sent. The Rabby-signed intent authorizes 0.100000 test USDC (100000 raw units) to receiving Solana wallet EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2, exact token account eLJeneXAJnyyBanwkQ64JZGaZLGmkVP4x92JBEhzSyw. The previous deposit was 1 USDC. The owner-selected recipient differs from the operator wallet; only the exact signed recipient and amount may be relayed.

Program 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5; cluster Solana Devnet; genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG; mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU. Deployed ELF hash fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489 rechecked. EVM owner 0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B; Safe B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu; source DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK; payer 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A.

EIP-712 signature verified; digest 0x8cb16311969ffd3d3e8641d04ca57e15e2ff94e10d096c7775cecf02bcfc4abd. Current nonce 1, signed next nonce 2. Source 1000000 -> 900000 raw; recipient 0 -> 100000 raw. Recipient account exists and its mint/authority/frozen state passed CLI checks. Unsigned on-chain simulation succeeded (err=null, 41725 CU). Fee 5000 lamports (0.000005 test SOL); rent 0. Deadline 2026-10-01 02:18:25 Asia/Qyzylorda, Unix 1790803105.

The owner intent is saved only in the ignored local operator directory. This document records its public parameters and digest. Sending requires separate transaction-specific user approval; re-read state and re-simulate before any approved send. An expired intent needs a fresh owner signature. See [public preflight state](yield-ai-v2-evm-withdraw-preflight.json).
