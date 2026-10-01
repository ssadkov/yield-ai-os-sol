# First human-signed EVM Safe Devnet withdrawal

Executed on 2026-10-01 (Asia/Qyzylorda), after the owner supplied a fresh Rabby EIP-712 intent and separately approved its exact parameters. The signed amount was 0.1 test USDC and the owner chose a different recipient from the operator. No alteration of the signed amount or recipient was made.

- Cluster: Solana Devnet; genesis EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG.
- Program: 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5; deployed ELF hash fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489, verified again after finalization.
- EVM owner: 0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B.
- Safe: B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu; source USDC account DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK.
- Mint: 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU; amount 100000 raw = 0.100000 test USDC.
- Receiving Solana wallet: EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2; exact USDC account eLJeneXAJnyyBanwkQ64JZGaZLGmkVP4x92JBEhzSyw.
- Payer: 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A; actual fee 5000 lamports (0.000005 test SOL), rent 0.
- EIP-712 digest: 0x8cb16311969ffd3d3e8641d04ca57e15e2ff94e10d096c7775cecf02bcfc4abd; signed intent nonce 2.
- Pre-send signature verification, fresh nonce/deadline checks and simulation passed (41725 CU).
- Transaction: 27uAmVaE4gxqrJecCeHXTc4QFjkZrNzvj2V8rZ5UwncRWTQZnmJZtUELHHs1eGXydvkcRePAzFpuC3CZBBzxQpQM.
- Finalized slot: 506038172; independent finalized readback slot 506039031.
- Receipt token balances and independent accounts both confirm Safe 1000000 -> 900000 raw (1 -> 0.9 USDC), recipient 0 -> 100000 raw (0 -> 0.1 USDC).
- Safe nonce advanced exactly once: 1 -> 2. Recipient mint and authority verified. Local lab readback also reports 0.9 USDC, nonce 2.

See [public finalized receipt](yield-ai-v2-evm-withdraw-result.json) and [reviewed preflight](yield-ai-v2-evm-withdraw-preflight.md). The existing protected operator signer remained local; web has no signer. No Mainnet or Production action was performed.

The human wallet has now completed a live deposit and partial owner-authorized withdrawal. Full-balance recovery to zero, first-creation/rent policy, automatic relayer budget controls and EVM bridge return remain separate work. Ordinary funding and CCTP stay disabled. Any further withdrawal needs a fresh intent (next nonce 3 if current nonce remains 2) and separate transaction approval.
