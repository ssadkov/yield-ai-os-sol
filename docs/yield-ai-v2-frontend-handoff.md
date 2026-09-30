# Yield AI v2: integration handoff for web and mobile

Status: 2026-09-30. This document distinguishes the deployed Solana-owner Safe from the experimental EVM-owner Safe. Do not route real or test USDC into the EVM-owner Safe until owner-authorized withdrawal is implemented and tested.

## Connect now

| Area | Contract for the UI | Source |
| --- | --- | --- |
| Networks | Explicit environment selection: Base Sepolia + Solana Devnet for tests; Base Mainnet + Solana Mainnet for production. Reject a wallet/RPC network mismatch before a signature. | `web/src/lib/v2CctpEngine.ts` (`CCTP_TESTNET`, `CCTP_MAINNET`) |
| Existing Solana-owner Safe | Owner is a **Solana public key**. Safe PDA seeds are `['vault', owner.toBytes()]`; USDC recipient is the associated token account of that PDA. Never use a raw wallet address as CCTP `mintRecipient`. | `web/src/lib/safeV2.ts` (`readSafe`), `web/src/lib/v2CctpEngine.ts` (`deriveSafeRecipient`, `validateRecipient`) |
| Safe state | Render existence, agent, allocation in basis points, route principal in raw USDC units, SOL/rent, and token balances. One USDC = 1,000,000 raw units. `ROUTES[0]` is Kamino USDC and `ROUTES[1]` is ONyc. | `web/src/lib/safeV2.ts` (`SafeState`, `ROUTES`) |
| Executor policy | Show whether enabled and the three independent USDC limits: per action, rolling 24-hour volume, and principal. These are settings of the **Solana-owner** Safe. | `web/src/lib/safeV2.ts` (`readExecutorLimits`, `ExecutorLimitsState`) |
| Bridge progress | Persist source transaction hash, recipient Safe and ATA, source amount, fee ceiling, Circle/message identifiers, destination mint and final received amount. Use `BridgeStage` for pending/failed/settled UI; support recovery by source hash after reload. | `web/src/lib/v2CctpEngine.ts` (`BridgeTransfer`, `readJournal`, `refreshTransfer`) |
| Fee review | Request a fresh Circle quote before each burn. Display amount, `maxFee`, minimum received, Base gas estimate, exact recipient ATA and source/destination networks. Quotes and gas are dynamic. | `web/src/lib/v2CctpEngine.ts` (`fetchFeeQuote`, `maxFeeRaw`) |

Program IDs and USDC mints are environment config, not user-derived addresses: Devnet `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5` with test USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`; Mainnet `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` with native USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. The current v2 web bundle uses its IDL address; `NEXT_PUBLIC_V2_PROGRAM_ID` is an optional matching override. Do not use the legacy `NEXT_PUBLIC_PROGRAM_ID` to select a v2 program. Confirm deployed binary/config and RPC genesis at runtime. The testnet bridge route previously completed a Base Sepolia burn and Solana Devnet Safe ATA mint; that test does not validate the new EVM-owner Safe.

## EVM-owner Safe: devnet prototype only

The planned owner identity is the EVM 20-byte address returned by the connected EIP-1193 wallet. Never derive a Solana owner from an EVM address and never require a MetaMask Solana account for this route. The proposed Safe PDA uses `['vault_evm', evmAddress20]` under the Devnet program. A relayer pays Solana rent and fees; the EVM wallet signs a typed intent. The first intent changes allocation only. It has no custody or withdrawal path yet. See `docs/yield-ai-v2-evm-owner.md` for the exact signature payload and current test gate.

The first EVM-owner lab is at `/v2/evm-devnet`. It discovers EIP-6963 wallets, connects an EVM account, derives the Safe and test-USDC ATA, reads Devnet state, and signs a route-0 allocation target using EIP-712. `/api/v2/evm-devnet` GET reads and checks the account; POST checks the signature and returns a canonical intent. Neither endpoint sends a transaction. The operator relay CLI simulates and, only after separate approval, sends the Devnet transaction. There is no automatic relay service or production EVM Safe creation flow yet. The Devnet program upgrade and live fixture EIP-712 allocation probe passed; see `docs/yield-ai-v2-evm-owner.md` for finalized transaction and state evidence. The current `/v2/safe` page still supports only the Solana-owner Safe. Keep any USDC funding or burn disabled until owner-authorized withdrawal exists and the recipient ATA is validated immediately before a burn. Rabby, MetaMask imported accounts, and hardware wallets should all enter through EIP-1193 account selection and typed-signature capability checks, with explicit unsupported-wallet errors.

For mobile, the stable part is the account model and typed intent: take the actual 20-byte EVM address from the connected account, derive `['vault_evm', address20]` with the **Devnet** program for this lab, show the derived Safe and ATA, and sign the exact `SetAllocation` EIP-712 payload in `web/src/lib/v2EvmDevnet.ts`. Treat nonce/deadline as fresh values and verify the chain state again before relay. Do not derive an EVM-owned Safe from a MetaMask Solana address or use the Solana-owner Safe IDL/parser for this account. The relay transport and custody operations are still experimental and should not be embedded as fixed mobile assumptions.

The first user-wallet Devnet transaction finalized: EVM owner `0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B` now has Safe `B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu`, nonce `1`, and route-0 allocation `5000` bps; see the transaction and fee evidence in `docs/yield-ai-v2-evm-owner.md`. The EIP-712 domain binds the Solana program by `salt` and the message includes Devnet genesis, Safe, action, nonce and deadline. **No browser hostname is signed.** The wallet presents the requesting origin, but the contract does not verify a website domain. This lab proves setup authorization only; keep the Safe unfunded until custody and withdrawal are implemented.

## Acceptance fixtures

- Existing Mainnet program: `https://solscan.io/account/yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`.
- Existing Solana-owner Safe withdrawal: Kamino step `5wXWkCcmZBAzj7QDuvhPytrSqAZK44uqmmpxstBcPikRo7yo9TvmvKEaoCrZWSqCv6qmPv9HDAetguhzQkn9DVZM`, then USDC step `2atdNN4G9FauvvuTqhQbhF4LkmV7Hq5ioA6K9YeAY1L79ZRRfBitjerrWcmo2YJwdXt1VfufsbEdLhur97bZG5sC`.
- Testnet CCTP source `0x76dc3e6f7fdd21e28a051b466a0b6211ab9858cda7e6b5ec3468426fd9186cb7`; destination mint `zCaBdro25KDzN2n388zmwabGqN9LXyAEwSJDWZz8m2uxoHZoMjks95qjcrV2HmMafkhTWaYrkQbt2H8pjsfdqJg` (1.825754 test USDC received from a 2 USDC burn, per the bridge journal).

## Do not assume stable yet

Owner-authorized custody instructions, automatic relayer API, sponsor/rent accounting, exact fee policy, and ability to use the EVM Safe with Kamino/ONyc are still pending. The existing Solana-owner `Vault` IDL and `readSafe` parser do not decode `EvmVault`. Mainnet CCTP sending to an EVM Safe stays disabled.
