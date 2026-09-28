# Yield AI v2: CCTP Mainnet Preview

Status: Mainnet route prepared for read-only Preview on 2026-09-28. No Mainnet CCTP burn has been sent through this route.

## Recipient and wallet roles

MetaMask's **Base Mainnet EVM account** is the USDC source and signs the Circle approval and burn. The connected **Solana public key** is the owner of the personal Safe. The Solana address shown by MetaMask may be derived from the same recovery phrase, but the app reads that address from the connected Solana wallet; it does not derive it from the EVM `0x` address or ask for a seed. The CCTP `mintRecipient` is the Safe's *native USDC associated token account* (ATA), encoded as `bytes32`. A mint to the owner's own ATA would leave the USDC outside the Safe.

The Base/EVM connection and the Solana connection require separate wallet permissions. Connect the Safe owner through **Solana Safe owner → Select Wallet**, or use **Connect MetaMask Solana directly** if the wallet adapter selects MetaMask but fails to connect. The direct button calls the MetaMask Connect Solana client with Mainnet RPC and reads the public address returned by MetaMask; it does not derive a Solana address from the EVM `0x` address. Then use **Connect MetaMask Base Mainnet source** separately. Changing MetaMask accounts can change both addresses; check the displayed Solana owner against the Safe you intend to fund. The UI can derive Safe and ATA addresses before they exist, but enables no burn until Mainnet account data confirms both are initialized and the ATA is owned by that Safe. For real sends, it checks the selected Solana account again before approval and burn.

The 2026-09-28 Preview incident showed MetaMask in the Solana wallet picker but no connected owner. The adapter's connection failure cleared the selection without showing the error; the old Base button attempted Solana selection only *after* a successful Base chain switch. These UI issues are corrected by visible connection errors and an independent direct MetaMask Solana button. The underlying reason the user's adapter connection failed is not yet known; retrying on the new Preview will expose its error, while the direct client offers another route. This browser behavior has not yet been retested by the owner.

For the existing pilot owner `EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2`, the v2 program is `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`, the Safe PDA is `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ`, and the native USDC ATA is `B9LQ5JfXnXAt5QVXqC7zR2WqZJab38XLt71qHyWQQ9r6`. These were derived from the program and read-only checked against Mainnet account owner and mint on 2026-09-28. Every connected owner is checked afresh; these addresses are not hardcoded as recipients.

## Route and safeguards

- Source: Base Mainnet chain ID 8453, native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Circle TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, domain 6.
- Destination: Solana Mainnet genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, native USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, domain 5.
- The page validates the genesis, Safe program/owner, and ATA token owner/mint before showing an eligible recipient, and repeats validation immediately before burn. It shows the EVM source, Safe, ATA, amount, fresh Circle fast/forwarding quote, maximum Circle fee and minimum receipt. Base gas is additional.
- The page rechecks MetaMask chain/account after approval, simulates the approval and burn, and refuses a newly increased fee ceiling until the user reviews it. A confirmed EVM receipt must emit exactly one authentic Circle `DepositForBurn` event for the intended ATA, token and forwarding hook.
- Source and destination journals have separate browser storage keys. A restarted session can resume from its saved source hash; another device can import the source hash after connecting the same Safe owner. `settled` requires Circle `complete` / relay `COMPLETE` and a finalized Solana transaction showing at least `burn amount - approved maxFee` credited to the exact Safe ATA. The hash should be retained because there is no server journal.
- The page is `/v2/cctp/mainnet`. `NEXT_PUBLIC_V2_CCTP_MAINNET_ENABLED=1` exposes it in a protected Preview. `NEXT_PUBLIC_V2_CCTP_MAINNET_SEND_ENABLED=1` is a **separate real-funds switch**; leave it unset/`0` until the live pilot is explicitly authorized. The original `/v2/cctp` stays on Base Sepolia → Solana Devnet, with its own flag `NEXT_PUBLIC_V2_CCTP_ENABLED=1`.

The live Circle fee quote is dynamic. In a read-only snapshot on 2026-09-28, the Base→Solana fast route reported 1.3 bps plus 0.136054 USDC forwarding; this is neither a guaranteed future fee nor the transaction's final charged fee. A tiny Mainnet transfer pays the fixed forwarding fee, so the UI must refresh before signing and must show the net amount.

For example, the user's Preview screenshot showed 2.000000 USDC, a 1.3 bps protocol quote and 0.136756 USDC forwarding quote. The protocol component is 0.000260 USDC. The configured 20% forwarding buffer gives a ceiling of 0.164108 USDC for forwarding, so `maxFee = 0.164368 USDC` and `minimum received = 1.835632 USDC`. This is a conservative minimum based on the burn ceiling, not a promise of the exact mint. Base ETH gas is extra. The screenshot's selected Base account had 0 USDC, and the Solana owner was disconnected, so no transfer could be submitted.

## Release gate

1. Confirm protected Preview uses the Mainnet program ID and RPC proxy, then inspect the same owner/Safe/ATA and live quote without a send button.
2. Exercise browser restart and cross-device source-hash recovery on the completed Devnet transfer. Check rejection of a wrong owner, wrong chain, wrong ATA and failed/pending relay.
3. Enable Mainnet sending only for a separately authorized, small real-USDC pilot: connect the intended Base source and Solana Safe owner, review amount/fee/ATA, burn, verify finalized mint and Safe balance, then perform an owner-signed full withdrawal. Record both chain fees and Circle fee.
4. After that cycle, review whether to expose the route in Production. CCTP receipt alone does not allocate funds into Kamino or ONyc.

Sources: [Circle contract addresses](https://developers.circle.com/cctp/references/contract-addresses), [Forwarding Service and Solana ATA](https://developers.circle.com/cctp/concepts/forwarding-service), [Circle forwarding transfer guide](https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service), [native USDC on Base](https://www.circle.com/multi-chain-usdc/base), [MetaMask Solana account addresses](https://support.metamask.io/configure/networks/navigating-solana).
