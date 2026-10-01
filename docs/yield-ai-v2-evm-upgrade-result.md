# EVM-owner withdrawal: confirmed Devnet upgrade

Status: 2026-09-30. The user separately approved the exact upgrade packet, seeded buffer and budget. The reviewed binary is now deployed and independently verified on Devnet. No deposit or EVM-owner withdrawal has been sent yet. Mainnet and Production were not changed.

## Finalized evidence

Program: 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5.
ProgramData: H5evLv9yEPaSRacNTYv5y4Tjdj3gJByUgavwMg66xTBg.
Authority/payer/refund recipient: 8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A (unchanged).

- [Buffer creation](https://explorer.solana.com/tx/5o8nhuVxuRk8owLW9ujjMMYekgGXqHPuKNpN9ysMfCboRKPaP4awNPA2EWdp98txdyQdeuJwhJ5HGS4Ur4MxWJ9Q?cluster=devnet): finalized slot 505999289. The approved seeded buffer HWZmWntMjPbMGUnFP2fh37kmGBuYD5ykx9RH23i8zPvp received 3500307960 lamports. No new private key was created for this address.
- 718 write transactions: all finalized successfully, each simulated before send. The complete public signature/offset journal is the ignored local artifact target/deploy/evm-withdraw-upgrade-journal.json. Uploaded ELF hash matched the reviewed binary before extension/upgrade.
- [ProgramData extension](https://explorer.solana.com/tx/5EzmZ5RkiUK7xabP7r9UACjTvZwNGTQDiNWX2uNCt4tAdCiVTnZGL9qiXQmZko3UKGtcYW5y4uDnMiFEpKRAWRxY?cluster=devnet): finalized slot 506001725; +21728 bytes; +110378240 lamports rent; 5000-lamport network fee. Its unsigned simulation succeeded with 2820 CU.
- [Final upgrade](https://explorer.solana.com/tx/5sNqPGyyatytBKAEpnQcdLSFPUD9K2kxEoefTkhU28hZuN23ueE6RnYS6bBiPCbiW3PJ1wwfWZ1UtpKiWMT5UprX?cluster=devnet): finalized slot 506001736, err=null, 5000-lamport fee. The actual upgrade was simulated against the fully uploaded buffer first: err=null, 2670 CU, expected deployed hash, full buffer refund and unchanged Safe/ATA.

The on-chain ELF is exactly 688864 bytes, SHA-256 fee494161131cc44fb572f3bcbf5b019170b4414a41221b614f6337b5aaa7489. ProgramData is 688909 bytes, executable program remains enabled, and its deployment slot equals the upgrade receipt slot. Independent RPC read-back at finalized slot 506002229 confirmed the ELF hash, receipt and empty Safe. The buffer is absent: its entire funding was returned to the reviewed payer as part of successful upgrade; no separate Close transaction was needed.

ProgramData extension and upgrade were separate transactions. Extension records its own slot; the loader rejects upgrade in that same slot. Both were individually simulated and finalized within the previously reviewed budget. See [the loader implementation](https://github.com/anza-xyz/agave/blob/v3.1.12/programs/bpf_loader/src/lib.rs).

## Cost reconciliation

| Item | Lamports | Test SOL |
| --- | ---: | ---: |
| Payer before | 12460952494 | 12.460952494 |
| Payer after | 12346969254 | 12.346969254 |
| Additional ProgramData rent retained | 110378240 | 0.110378240 |
| Total fees: create + 718 writes + extension + upgrade | 3605000 | 0.003605000 |
| Net committed/spent | 113983240 | 0.113983240 |
| Buffer rent refunded | 3500307960 | 3.500307960 |

The payer difference exactly equals additional ProgramData rent plus 721 single-signature transaction fees. The total fee is below the approved 50000000-lamport cap. The initial local signing preparation failed signature verification before any send RPC call: the buffer was absent, the signature absent and payer balance unchanged. The source-array cleanup was corrected to operate on a separate copy; signature serialization now verifies before journal reservation or network send. This attempt incurred no on-chain fee; it remains recorded as not_sent_local_serialization_error in the journal.

## Safe and next manual gate

EVM owner: 0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B.
Safe: B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu.
USDC ATA: DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK.
Nonce: 1. Test-USDC balance: 0 raw. Allocation: [5000,0,0,0,0,0,0,0].

The entire Safe and token account data hashes are unchanged by upgrade. No owner signature was generated or reused for this upgrade. A fresh owner-signed withdrawal and small funded recovery cycle remain to be performed with separately reviewed recipient, amount, fees and permission. Keep ordinary funding/CCTP disabled. The local signing page may enable only the server-side withdrawal review/verification flag; it never receives the operator signer.

See [the manual cycle runbook](yield-ai-v2-evm-manual-cycle.md) and [public result JSON](yield-ai-v2-evm-upgrade-result.json). The main checkout remains clean at b2ed575; Solana API files were not edited. EVM implementation changes remain local/uncommitted on codex/yield-ai-v2-evm-owner at bbc23fb. There is no automatic relayer service or Production deployment.

## Local manual-test runtime

The Windows signing lab is running at http://localhost:3101/v2/evm-devnet with server-only withdrawal review enabled and no operator signer in the web process. HTTP page GET returned 200; the live API returned the expected Devnet program, owner, Safe/ATA, nonce 1, 0 USDC and withdrawalEnabled=true. The receiving Solana address and fresh owner-signed intent are still required before reviewing/authorizing the small funded cycle. See the manual runbook for the verified local startup command.
