# Manual EVM-owner Devnet recovery cycle

Current result: the full 1-USDC recovery cycle is finalized (0.1 + 0.9 withdrawals); Safe balance 0, recipient 1 USDC, nonce 3. See [full recovery receipt](yield-ai-v2-evm-full-recovery-result.md). Historical observations and approval packets below are preserved. Ordinary funding/CCTP and automatic relay remain disabled.

Latest confirmed state (2026-10-01 Asia/Qyzylorda): 1-USDC deposit and owner-selected 0.1-USDC withdrawal finalized. Safe now holds 0.9 USDC, nonce 2; receiving wallet EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2 received 0.1 USDC. See [withdrawal receipt](yield-ai-v2-evm-withdraw-result.md). The original full-recovery steps below remain a proposed test; a next withdrawal needs fresh nonce 3 if state remains unchanged.


This is a review/signing runbook. Every public deposit and withdrawal needs its own exact transaction review and user approval. No live recovery cycle has been run yet. Ordinary funding/CCTP stays disabled.

## Wallet and environment

Open the local EVM lab at /v2/evm-devnet using the browser where MetaMask or Rabby is installed. Use the connected EVM EOA 0x70d5d723Ba7f39Cfb676C67Bbd4b5D6aE8047f4B, the existing Devnet Safe B9TDuTrEihNcX2StDwGn4qua6Dd921P9GLxoPgaF7WNu and its USDC ATA DGMgUNQ3VeBoU4HxCYfxtqhg93Zjt2dyEHQCxgJfu7WK. MetaMask needs only its EVM account and EIP-712 support. Do not import a Solana account or derive a recipient from the EVM address.

The receiving Solana wallet is chosen by the user. Derive and verify its existing canonical test-USDC ATA for mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU (six decimals). A missing recipient ATA requires its own rent/creation review. The receiving wallet signs nothing for this withdrawal. No private key or seed phrase is requested.

## Check connection without moving funds

1. Connect the intended wallet/account and compare the full EVM address, Safe and ATA above.
2. Refresh state: the last pre-upgrade read was nonce 1, 0 USDC. Always use the current on-chain read.
3. Change accounts, disconnect and reconnect: any old verified intent must be invalidated. Rejecting a wallet prompt should leave a readable error and permit retry.
4. An allocation signature is optional; signing and API verification do not send it. Relaying an allocation consumes the same nonce as withdrawal, so do not relay it during the recovery test without re-reading state and requesting a fresh withdrawal signature.

## Exact deposit review

Executed approved test deposit: 1.000000 test USDC = 1000000 raw units. The user explicitly approved increasing the amount from 0.1 to 1 USDC. Deposit is finalized; Safe balance is 1 USDC and nonce remains 1. See [deposit receipt](yield-ai-v2-evm-deposit-result.md). Any additional deposit requires a new concrete review and approval. Show the sender's actual SPL Token USDC account and its balance, Devnet genesis, destination Safe ATA, amount and fee payer. Deposit is an ordinary SPL Token transfer_checked into the existing Safe ATA; the EVM wallet does not sign a deposit authorization.

If the user sends manually from a Solana wallet, they review/sign that transfer in their wallet and provide its transaction signature. If the operator sponsors it, simulate and obtain a separate approval before sending. Confirm the finalized receipt and exactly +1000000 raw Safe balance before asking for a withdrawal signature.

## Owner withdrawal review/signature

1. Enter the chosen receiving Solana wallet address and 1 USDC in the lab. The lab derives the exact existing destination ATA and reads its mint/token authority.
2. Review the WithdrawUsdc typed request: Devnet genesis, program salt, Safe, test-USDC mint, amountRaw=1000000, recipientTokenAccount, recipientOwner, fresh nonce=current+1 and deadline (Unix seconds). No hostname is signed.
3. Sign once in MetaMask/Rabby. Copy the API-verified intent JSON to the operator. The lab/API sends no Solana transaction.
4. The operator runs client/src/v2EvmOwnerRelay.ts --preflight <local-intent.json>. This reads no payer key. Review destination, amount, current balance/nonce, fee/rent and simulation.
5. Obtain separate permission for that exact withdrawal, then send once using the protected operator signer and the existing CLI acknowledgement. Do not reuse an old signature or silently resign/retry after uncertain submission.
6. For a full 1-USDC return, verify finalized receipt, Safe balance back to 0 raw, recipient +1000000 raw, nonce advanced once, and the actual destination mint/authority. If the Safe nonce is still 1 before signing and no allocation is relayed, the withdrawal intent uses nonce 2.

Cancel/change-account/deadline expiry and malformed-intent behavior can be checked before sending. The local security suite already exercised tampering, wrong signer/action/domain, replay, expiry, equivalent high-s and failed-CPI state rollback. A human wallet signing cycle remains required.

## Local signing lab

The reviewed upgrade is finalized and its ELF hash verified. The local Windows server is running at http://localhost:3101/v2/evm-devnet; HTTP page/state checks passed. To restart this existing WSL-built app on Windows, run from the EVM worktree web directory using the installed Node 24:

~~~powershell
$env:V2_EVM_DEVNET_WITHDRAW_ENABLED = "true"
$env:V2_EVM_DEVNET_RPC_URL = "https://api.devnet.solana.com"
& "C:\work\nodejs\node.exe" --require ./scripts/v2-evm-local-windows.cjs node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3101
~~~

The server-only flag enables intent review/signature verification. This server receives no operator keypair or Mainnet authority. It uses read-only public Devnet RPC unless an existing server-only Devnet RPC is provided. This is local runtime, not Production deployment or an automatic relayer. Open http://localhost:3101/v2/evm-devnet in the user's wallet-enabled browser. With zero Safe balance, the withdrawal button correctly stays disabled.

Upgrade evidence is recorded separately in [the approval packet](yield-ai-v2-evm-upgrade-preflight.md) and the upgrade execution report after finalization. This runbook grants no on-chain permissions beyond explicit subsequent transaction approvals.

The local Windows adapter maps only four verified Linux-generated external package aliases back to their exact original top-level packages, for both CommonJS and ESM. It modifies no application source or package version and is not used by Production. The WSL server stalled in p9_client_rpc on the mounted Windows filesystem and was stopped; only the Windows lab process remains running. The adapter uses installed Node 24 module.registerHooks, documented in the [Node module API](https://nodejs.org/docs/latest-v24.x/api/module.html#moduleregisterhooksoptions). This local compatibility step does not constitute a Production deployment.
