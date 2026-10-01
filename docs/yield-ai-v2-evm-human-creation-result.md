# Human-wallet Safe creation through dedicated Devnet relayer

[Creation transaction](https://explorer.solana.com/tx/2ShNecBfiDZMDW8NUKN1mAJFHkTUW71RDuyMzWQ8s9T4hzWBaLXFBCnAaCLk4ABKrVkD8Gyo1bLxiJrEyrnBoXtJ?cluster=devnet) finalized at slot 506217071, error null. Independent finalized RPC readback and the durable relayer journal/public proxy agree; see [public receipt](yield-ai-v2-evm-human-creation-result.json).

- EVM owner: 0xb659DA13418527601C52D4220536C12397F20855.
- Safe: bn4KYuYg6fvbqPEh13rC1Exr5HuPCC455KiC1dTEnEr; USDC ATA: rQUE1MGE7jwzyCoUdWTphYKP28hjU3QqcnMjnGCwLxm.
- Program: 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5; canonical Devnet mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU.
- Instruction: create_evm_safe_authorized, creation nonce 1, current nonce 1.
- Safe layout/discriminator and EVM owner bytes validated; recorded rent payer is the separate service signer GhK2bfKSsFgVrm6RbgHZkMzQ34pvYh5tGjfda3UchY1s.
- Safe USDC balance 0 raw; all allocations 0; ATA authority is Safe, with no delegate, close authority or frozen state.
- Rent 5720080 lamports, fee 5000; sponsor debit 5725080 (0.00572508 test SOL). Sponsor balance 50000000 -> 44274920 lamports.
- Relayer digest 0xbad2712e251ac087aed37a34a145cf093bb41db35ad41dc360927683628dca6d, state finalized. Reviewed deployed ELF pin matched 4a2a277a6df06bbcafe172f90ff88bfc3d31fe34b4309b2b6913a4d7b70fdf98.

The first fresh human-wallet creation through the bounded automatic service is now confirmed. No additional Devnet chat approval was required. The EVM owner signature remained mandatory; the service sponsor paid rent/fees and gained no token withdrawal authority. This readback loaded no signer. The previous readiness snapshot recorded absent accounts before this transaction and remains historical.

Next evidence still required for this new Safe: a small test-USDC deposit, next-nonce cancellation/stale-intent rejection, and fresh owner-authorized full recovery through the dedicated relayer. Ordinary funding/CCTP, Mainnet rollout and Safe close/refunds remain disabled.
