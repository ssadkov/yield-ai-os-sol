# Yield AI v2 — Colosseum MVP

Status: implementation started in the isolated `codex/yield-ai-v2` worktree on 2026-09-23. This document describes the intended product and records which acceptance gates have actually passed. A green local test does not imply a devnet deployment or a safe mainnet upgrade.

## Product boundary

One user controls one personal Solana Safe PDA. The first deposit asset is native Solana USDC. A mobile user connects MetaMask, deposits USDC, sees one current Safe value in USDC, and can request a full exit. The strategy selects and moves funds among approved Kamino vaults; vault selection and allocation are not user-facing controls. The displayed value is an estimate until positions are unwound and actual USDC is received. There is no pooled share token in this MVP.

The owner key for the first implementation is the **Solana public key exposed by MetaMask**, not the EVM `0x` address. The EVM address is used only for a separately authenticated EVM deposit and cross-chain transfer. A user must explicitly sign a challenge with both keys to link them; the app must not infer ownership from MetaMask showing both addresses in one account. If EVM-only recovery is required, it needs a separate contract authorization design.

JLP, JLP Multiply, xStock/USDC LP and stock Multiply are future routes. They must not enter the initial risk slider or automatic execution until their own full-cycle exits and economics have been tested.

## Baseline findings

- The original `execute_protocol_cpi` and `execute_swap_cpi` gave the agent arbitrary instruction data and accounts while `invoke_signed` gave the inner program the Safe PDA signature. The allowlist includes SPL Token, Token-2022 and System Program, so it was not a fund-preservation boundary.
- The existing `client/src/smoke.ts` checks only initialize, direct deposit and a partial direct withdrawal. It does not test agent authority, protocol receipt tokens, or a full exit.
- The web wallet provider explicitly lists Phantom and Solflare. MetaMask Solana ownership-message signing worked in the desktop extension, but devnet transaction signing failed the network-display gate twice. MetaMask documents Solana devnet support for its browser extension only; mobile currently supports Solana mainnet only.
- Existing Kamino building uses `https://api.kamino.finance` and mainnet program IDs. The Jupiter swap builder rejects devnet. These integrations need a cluster-specific fixture or a small mainnet test after the Safe gate; a devnet Safe test cannot establish their production behavior.
- The main checkout contains unrelated uncommitted contract, IDL, adapter and document changes. This worktree starts from commit `d5fc213` and does not copy those changes. In particular, the main checkout's draft lamport-refund and empty-token-account-close instructions are absent here.

## First security slice in this branch

The two generic CPI entrypoints are restricted to the Safe owner. This initially disabled agent automation; the later typed Kamino deposit/withdraw instructions restore only that constrained route. The owner can rotate the agent or set it to the default pubkey to revoke access. This change preserves the existing `Vault` account layout, but it changes the behavior of an existing instruction and must not be deployed as an unreviewed upgrade to the live program. A separate v2 program ID was deployed to devnet; mainnet deployment still needs a review and migration plan.

`client/src/v2SecuritySmoke.ts` is a local-validator regression: it deposits a test SPL token, attempts to transfer it from the Safe to an attacker through both generic CPI entrypoints using the agent signature, checks balances, rejects non-owner agent rotation, checks owner revocation and rotation, then returns part of the deposit via owner-signed CPI and withdraws the rest directly. This is a transaction test script; do not point it at mainnet. It passed on a local validator with disposable in-memory keys on 2026-09-23.

`/v2/lab` is a devnet-only, opt-in wallet probe. It verifies a Solana ownership-message signature against the selected public key using WebCrypto Ed25519. A no-broadcast v0 memo probe is available for non-MetaMask Wallet Standard wallets when they declare solana:devnet and v0 support, the RPC genesis matches devnet, and the address has at least 0.001 devnet SOL. MetaMask transaction signing is disabled after its popup showed Mainnet even with an explicit devnet chain request. The lab displays the selected Solana address, wallet-declared chains, balance, and derived PDA when a separate v2 program ID is configured. Enable it with NEXT_PUBLIC_RPC_URL pointing to devnet and NEXT_PUBLIC_V2_LAB_ENABLED=1; set NEXT_PUBLIC_V2_PROGRAM_ID once deployed. Record the selected wallet, address, capabilities and exact success/failure. If a browser lacks WebCrypto Ed25519, the probe reports that error rather than claiming verification.

### Agent permission boundary

The intended agent actions are narrowly named Kamino deposit/withdraw and, later, ONyc buy/sell. The Kamino path now checks the instruction type, Safe destination, mint/vault, amount bounds, and post-action balances or shares. ONyc and multi-vault routing need their own equivalent constraints. The owner must be able to revoke the agent immediately. Generic CPI access must never be restored to the agent as a shortcut. A backend quote or allowlist alone cannot enforce custody.

## Acceptance gates

| Gate | Test and pass condition | State |
| --- | --- | --- |
| 0. Contract authority | Agent cannot transfer USDC/SOL to a third party via either generic CPI; non-owner cannot rotate agent; owner can revoke and withdraw all direct tokens. | Local validator and devnet PASS 2026-09-23, including lifecycle instructions (`close_empty_token_account`, `withdraw_excess_lamports`, `close_safe` + re-init recovery). |
| 1. Wallet signing | A supported wallet exposes the expected Solana address, signs an owner challenge and Safe transaction on the selected cluster, rejects a changed network or account, and reconnects to the same Safe. Verify the actual mobile wallet separately. | MetaMask: devnet transactions impossible (3 probes showed Mainnet). Mainnet PASS 2026-09-23 on desktop extension and in the MetaMask Mobile in-app browser via Wallet Standard `signAndSendTransaction` with explicit `solana:mainnet`; `signTransaction` hangs. Safe transactions with MetaMask wait for the mainnet deploy. |
| 2. Devnet Safe | Separate v2 program ID; test USDC mint and cluster checked; simulate, then initialize, deposit and full direct withdrawal. Record signatures, balance deltas, fees and rent. | PASS 2026-09-23: v2 program `8xa1…` on devnet; initialize, deposit, owner CPI, full withdraw (see *Security smoke на devnet*). |
| 3. Circle CCTP | Base Sepolia test USDC burn, attestation and Solana Devnet mint to the intended receiver; resume after app close or interrupted relay; no double credit. Bridge status is keyed by source transaction and message ID. | Pending. |
| 4. Kamino from Safe | Deposit from Safe PDA, record shares, withdraw all shares after a vault `invest`, reconcile USDC and rent. A normal-wallet transaction does not pass. | Local mainnet fork PASS, including withdrawal from an invested reserve; small real mainnet cycle and positive-gain fee transfer pending. |
| 5. ONyc exit | Quote and execute USDC→ONyc→USDC at several sizes; enforce min-out, stale quote and liquidity limits; reconcile actual proceeds against displayed value and NAV. | Pending mainnet market test. |
| 6. Full product exit | Stop new allocation, unwind Kamino, sell ONyc within user-approved bounds, transfer all available USDC and show any dust or failed step. Retry resumes from observed chain state. | Kamino + idle USDC path implemented in UI and local fork tested; ONyc, automatic allocation stop, and real mainnet cycle pending. |
| 7. Cost floor | Record transaction fee, priority fee, rent, bridge fee and slippage for $100, $1,000 and $10,000; set the minimum useful deposit and avoid opening the ONyc leg when cost dominates. | Pending measured runs. |

For gate 7, record each size as one complete round trip. Blank cells mean unmeasured; do not substitute quoted APY for realized proceeds.

| Starting USDC | Bridge fee | Solana fees + priority | Rent retained / recovered | Kamino entry + exit | ONyc spread + slippage | Final USDC | Net cost |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | — | — | — | — | — | — | — |
| 1,000 | — | — | — | — | — | — | — |
| 10,000 | — | — | — | — | — | — | — |

## Delivery order

1. Finish gate 0 locally. Generate the IDL from the actual build, review it against the program, and keep the v2 program on its own ID. Do not reuse a live user's Safe or deploy this branch as a mainnet upgrade.
2. Keep the wallet lab as the signing harness. For the desktop MetaMask extension, investigate the official MetaMask Connect Solana client configured for devnet and its CAIP-2 scope before another no-broadcast signature probe. Use a confirmed devnet Solana wallet for program tests. The mobile MetaMask Solana path currently needs mainnet-only validation and cannot serve as a devnet signer.
3. Run gate 2 with a test mint, then use Circle's test USDC and run gate 3. The CCTP transfer and Safe deposit are separate states with persistent recovery.
4. Implement a single Kamino USDC kVault path with its own constrained agent action and an owner recovery path. Reconcile shares and USDC on every step.
5. Add the secondary-market ONyc route only after executable sell quotes and a full exit test. Keep strategy selection internal; show the current USDC value, exit status, actual balances and costs to the owner.

### Contract roadmap: account lifecycle (added 2026-09-23)

The old mainnet program `3Vtz…` (closed 2026-09-23) had no way to reclaim rent except through the generic CPI, and could not release excess PDA lamports or close a Safe. **Implemented in v2 on 2026-09-23** as owner-only instructions:

- `close_empty_token_account`: `has_one = owner`, `token::authority = vault`, `token::token_program = token_program`, `amount == 0`; SPL Token and Token-2022. Rent goes to the **owner**, never to the caller or agent.
- `withdraw_excess_lamports`: debits Safe PDA lamports above `Rent::minimum_balance(data_len)` directly (the PDA is program-owned) and credits the owner; fails with `NoExcessLamports` when there is nothing to move. Replaces the uncommitted `refund_excess_lamports` draft in the main checkout, which let the agent collect lamports.
- `close_safe`: Anchor `close = owner`. The program cannot enumerate token accounts, so it does not claim the Safe is empty; the UI must close or empty ATAs first. Leftovers remain recoverable because the PDA is `["vault", owner]` and `initialize` now uses `init_if_needed` for the Safe USDC ATA: re-initializing restores control over the same accounts. The test proves this with 0.8 test-USDC left in the ATA through close → re-init → withdraw.
- Each instruction is signed by the owner alone and can be batched, so one MetaMask `signAndSendTransaction` covers a full cleanup.
- Local validator: `v2-security` PASS on 2026-09-23 (all of the above plus non-owner rejections).
- Devnet: program `8xa1…` upgraded 2026-09-23, tx `2cgrZheWxRec8qox6gHzvYb4k81QmdiLsmzix3ehs6oWqvQTR8fWVMES4YCpBRnGpsmiFtFTiXDAdvAwZHQHUFeQ`, slot 503021452; on-chain sha256 `d5d0592d…10d51161` equals the local build (387 352 bytes within the 430 000 max-len). Upgrade cost 0.002 SOL (buffer rent is returned). `v2-security` on devnet **PASS** (owner `ByaTj52T…`, Safe `CBU2UTEp…`); the run cost 0.0042 SOL because `close_safe` now returns the Safe rent. The first attempt hit `Blockhash not found` from the load-balanced public RPC on a plain SOL transfer; the test now retries that case (up to 4 times).

### Roadmap: mainnet (target ~2026-09-30)

1. Deploy v2 to mainnet under a new program ID from `8xwj…` (≈2.7 SOL rent for the current 387 KB binary with ~10% headroom; payer holds 5.17 SOL).
2. Before the first external deposit: transfer upgrade authority to a Squads multisig (`solana program set-upgrade-authority … --skip-new-upgrade-authority-signer-check`).
3. Point the prod web build at the mainnet program; MetaMask mainnet cycle with $1 USDC (create Safe, deposit, full withdraw, close ATAs and Safe).
4. CCTP Base → Safe on mainnet with ~$2.

### Upgrade authority and multisig

- A program's upgrade authority can be reassigned after deploy with `solana program set-upgrade-authority <PROGRAM> --new-upgrade-authority <SQUADS_VAULT> --skip-new-upgrade-authority-signer-check`; a Squads vault is a PDA and cannot co-sign. After that, upgrades go through Squads proposals (buffer upload by any key, then `Upgrade` executed by the multisig).
- The fee payer or deployer key used for the initial deploy has no ongoing rights; only the upgrade authority matters. The program keypair (the ID) is also irrelevant after deploy.
- v2 has no global admin: authority is per Safe (the owner). If a global config is added later (pause, fees, allowed protocol list), store its admin as a `Pubkey` in a config PDA with a `set_admin` instruction, so it can also point at a Squads vault.
- Option for the end state: `--final` makes the program immutable. This is irreversible and removes the ability to patch bugs, so it is not for the MVP.

## Test commands and transaction boundary

`npm.cmd --prefix client run v2-security` runs transactions on a **local validator only** and requires a local RPC and a freshly generated `target/idl/yield_vault.json`. The script generates disposable payer and test-user keypairs in memory and uses local-validator airdrops. A devnet deployment or transaction must first be simulated and its recipient, amount, fee payer and cluster reviewed before a wallet signs it.

### Verification record — 2026-09-23

- `git diff --check`: passed.
- Client security script TypeScript check with `tsc --noEmit`: passed.
- Web TypeScript check with `tsc --noEmit --incremental false`: passed.
- `npm ci --offline` could not complete because the pinned `tsx` tarball was missing from the local npm cache. Type checking used the already installed dependencies from the original checkout via a worktree-local junction; no tracked dependency files were changed.
- Windows PATH lacks `cargo`, `rustc` and `anchor`; Ubuntu WSL has Rust 1.89.0, Anchor 0.32.1 and Solana CLI 3.1.12. The program **compiled successfully in WSL** after copying only the Rust source to Linux's temporary filesystem. The managed Windows worktree's `.git` pointer is not understood by WSL Git. A generated IDL and `.so` exist in that temporary build. Local-validator authority and full direct-withdrawal regression passed; no devnet transaction or deployment has occurred.
- Generated Anchor IDL was copied into `web/src/idl/yield_vault.json`; it includes `set_agent` and the new owner-only CPI descriptions.
- The existing program ID `3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s` is already deployed on devnet with authority `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`. This was a read-only CLI query; no upgrade was attempted. V2 needs a separate program ID.
- The local signing lab returned HTTP 200 at http://127.0.0.1:3000/v2/lab with a devnet RPC setting. In this Windows worktree, Next Turbopack rejects the external node_modules junction; node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 worked. A desktop MetaMask Solana ownership-message signature was verified for the user-provided account and devnet genesis. The first v0 memo request via the wallet adapter showed Solana Mainnet and a simulation-reverted warning. After fixing hydration, checking devnet genesis and SOL balance, and sending chain=solana:devnet directly through Wallet Standard, the second popup still showed Solana Mainnet; the user cancelled. No transaction was broadcast. MetaMask transaction signing is now disabled in the lab.
- Android and iOS MetaMask behavior remains untested here. MetaMask currently documents Solana devnet/testnet support only in its browser extension and Solana mainnet only on mobile; mobile MetaMask is therefore not the signer for devnet acceptance tests.

## Sources to recheck before execution

- [MetaMask Solana accounts and mobile use](https://support.metamask.io/configure/networks/navigating-solana)
- [MetaMask Connect Solana: extension devnet, mobile mainnet, supportedNetworks](https://docs.metamask.io/metamask-connect/solana/quickstart/javascript/)
- [MetaMask Connect Solana: v0 transaction and devnet CAIP-2 scope](https://docs.metamask.io/metamask-connect/solana/guides/send-transactions/versioned/)
- [Circle testnet CCTP sample with Base Sepolia and Solana Devnet](https://github.com/circlefin/circle-cctp-crosschain-transfer)
- [Kamino kVault program and deployment information](https://github.com/Kamino-Finance/kvault)

## Практический порядок для devnet

1. **Инструменты.** На Windows `cargo`/`anchor` не находятся в PATH. Проверенная Ubuntu в WSL: Rust 1.89.0, Anchor 0.32.1, Solana CLI 3.1.12. Сборка Anchor из Linux-копии исходников прошла; тест `v2-security` на `solana-test-validator` тоже прошёл. В тесте созданы одноразовые ключи только в памяти, 1 тестовый токен вошёл в Safe, агент не смог вывести его через оба generic CPI, владелец отозвал/сменил агента и вернул весь токен. Это локальная проверка кода, не devnet.
2. **MetaMask сегодня.** В MetaMask Extension открыть список адресов текущего account и скопировать именно Solana address. Записать его публичное значение и выбранный account. Переключиться на другой account и обратно: адрес должен восстановиться. Не передавать seed, private key или JSON keypair. MetaMask документирует отдельный Solana-адрес для каждого account, производный от той же Secret Recovery Phrase; адрес нельзя вычислять из видимого EVM `0x`. Проверка показала владение адресом через `signMessage`, но подпись devnet-транзакции пока заблокирована. По официальной документации MetaMask Mobile сейчас поддерживает Solana Mainnet, а Devnet/Testnet — только Extension.
3. **Лаборатория подписей.** Маршрут `/v2/lab` добавлен в эту ветку, но ещё не опубликован как HTTPS-preview. Он запускается с `NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com`, `NEXT_PUBLIC_USDC_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` и `NEXT_PUBLIC_V2_LAB_ENABLED=1`. После подключения кошелька страница показывает Solana owner, заявленные сети, genesis и баланс. Challenge локально проверяет подпись адреса. No-broadcast v0 memo доступен для совместимого devnet-кошелька, **кроме MetaMask**: окно MetaMask Extension дважды показало Mainnet, поэтому кнопка для него отключена. Для телефона нужен доступный ему HTTPS-адрес; `localhost` на компьютере в телефоне не откроется. Отдельный ID программы в `NEXT_PUBLIC_V2_PROGRAM_ID` появится после подготовки devnet deployment.
4. **Первые публичные транзакции.** Создать отдельный v2 program ID и тестовый devnet-кошелёк/способ подписи; не использовать неявно текущий CLI wallet, чей глобальный RPC настроен на mainnet. Проверить genesis, ID программы, mint Circle USDC, fee payer и публичный адрес получателя. Для каждой транзакции сначала симуляция и явная сводка (кластер, программа, получатель, токен, количество, fee payer), затем подпись. Владелец подписывает initialize/withdraw через кошелёк с подтверждённой поддержкой Solana Devnet. MetaMask Extension остаётся неподтверждённым для этого потока; MetaMask Mobile официально ограничен Solana Mainnet. Я могу собирать и отправлять транзакции через проверенный подписывающий интерфейс, не получая seed. Если потребуется независимый test-only operator, пользователь переводит тестовые токены только на заранее показанный и проверенный публичный адрес. Никаких реальных токенов в эту проверку не отправлять.

## CCTP: прямое поступление в Safe без отдельного bridge-контракта

Для входа Base Sepolia → Solana Devnet выбран маршрут Circle CCTP V2 с Forwarding Service. Сначала владелец создаёт Safe PDA и его USDC ATA. Затем фронт показывает EVM-источник, Safe PDA, **точный USDC ATA**, сумму, `maxFee` и ожидаемую сумму после комиссии; MetaMask подписывает approve и `depositForBurnWithHook` в официальном TokenMessengerV2. `mintRecipient` должен быть **адресом ATA**, закодированным как `bytes32`, а не адресом Safe PDA. Circle принимает ATA off-curve PDA и может создать ATA через свой forward hook, но в MVP ATA уже создаётся при `initialize`. Circle доставляет mint прямо в ATA Safe. Отдельный вызов `deposit` в нашем контракте для такого поступления не нужен: Safe владеет ATA, а актив определяется фактическим балансом token account. Это не означает запуск стратегии: Kamino/ONyc остаются отдельными действиями с лимитами и проверкой вывода.

`hookData` в CCTP — метаданные; ядро CCTP не исполняет произвольный вызов нашего Anchor-контракта. Здесь hook используется только для Circle Forwarding Service. Фронт после burn сохраняет source tx hash и идентификатор CCTP message, возобновляет проверку после закрытия приложения, получает `forwardTxHash`, проверяет devnet mint, правильный mint/ATA и прирост баланса. Повторный опрос не добавляет актив повторно в учёте. Если forwarding не пройдёт практический тест, запасной путь — mint в ATA владельца и отдельный owner-signed `deposit` в Safe, но только при подтверждённой возможности этого владельца подписать и отправить devnet-транзакцию. Переход с прямого ATA на запасной путь требует нового явного просмотра получателя перед burn.

Сначала проверяем публичные read-only адреса/котировку Circle и подтверждённый devnet signer, затем маленькую тестовую сумму CCTP и возврат из Safe. Devnet Kamino и ONyc нельзя считать проверенными по этой цепочке: их доступность и ликвидность подтверждаются отдельно.

### Источники для CCTP и кошелька

- [Circle: Forwarding Service, Solana ATA и off-curve PDA](https://developers.circle.com/cctp/concepts/forwarding-service)
- [Circle: Base Sepolia → Solana, комиссии и mintRecipient](https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service)
- [Circle: hookData не исполняется ядром CCTP](https://developers.circle.com/cctp/references/technical-guide)
- [MetaMask: Solana address, SRP и RPC](https://support.metamask.io/configure/networks/navigating-solana)
### Результат MetaMask Extension, 2026-09-23

Пользователь дважды получил локально проверенную подпись Solana `signMessage` для адреса `2twCpxj6cqztdXwgV7EabmtDnC7W7xGr12hNrEuxpcdj` и devnet genesis. Это подтверждает контроль над адресом, но не подпись devnet-транзакции. Первый v0 memo через wallet adapter показал **Solana Mainnet** и ошибку симуляции. Второй no-broadcast v0 memo через прямой Wallet Standard вызов явно передавал `chain=solana:devnet`, но MetaMask Extension снова показал **Solana Mainnet**; пользователь отменил. Ни одна транзакция не была подписана или отправлена. В лаборатории отключена кнопка подписи транзакции для MetaMask. Причина отображения Mainnet во втором случае ещё не подтверждена. Официальные примеры MetaMask Connect Solana используют devnet CAIP-2 scope `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` и инициализируют SDK с поддерживаемой сетью. Это следующий путь диагностики Extension. Для MetaMask Mobile документация указывает поддержку только Solana Mainnet, поэтому devnet-проверки Safe требуют другого кошелька.
### Следующий маршрут, 2026-09-23

После отказа CLI faucet по rate limit пользователь самостоятельно пополнил публичный адрес `2twCpxj6cqztdXwgV7EabmtDnC7W7xGr12hNrEuxpcdj`; read-only проверка **после отменённой второй пробы** показала **5 devnet SOL**. Никаких транзакций из лаборатории не отправляли. Повторять текущую MetaMask v0 пробу не нужно. Для Extension сначала подготовить отдельный путь через официальный MetaMask Connect Solana SDK с devnet RPC и CAIP-2 scope, проверить сеть в окне и подписать только no-broadcast memo. Пока это не пройдено, тестировать Safe через Phantom/Solflare или другой подтверждённый devnet signer. Не переводить тестовый USDC в Safe, владельцем которого назначен MetaMask Solana-адрес, пока не подтверждён подписанный owner withdrawal на devnet.




### Проба MetaMask Connect, 2026-09-23

В `web` добавлен `@metamask/connect-solana` (точная версия в `package.json`, установлен в собственный `node_modules` worktree; исходный checkout не менялся). Компонент `V2MetaMaskConnectProbe` на `/v2/lab`: проверяет devnet genesis и баланс ≥ 0,001 SOL, собирает v0 memo, симулирует его в devnet, затем создаёт клиент MetaMask Connect с `supportedNetworks: { devnet }` и запрашивает `solana:signTransaction` со scope `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`. Подпись проверяется локально (неизменность message, Ed25519 против выбранного адреса). Транзакция не отправляется. TypeScript проходит, страница компилируется без ошибок в консоли. Результат пробы на реальном MetaMask Extension ещё не получен.

Dev-сервер нужно запускать из `web/node_modules` самого worktree. Прежний процесс стартовал через junction на `C:\work\yield-ai-os-sol\web\node_modules`. После `npm install` в worktree webpack держал два экземпляра `@solana/wallet-adapter-react(-ui)`, и кнопка Select Wallet падала с ошибкой `WalletModalContext without providing one`. Лечится перезапуском из worktree с очищенным `.next`; после этого модалка открывается, новых ошибок в консоли нет.

### MetaMask Connect: результат, 2026-09-23

Третья no-broadcast проба, на этот раз через официальный `@metamask/connect-solana` с `supportedNetworks: { devnet }` и scope `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`: окно MetaMask Extension снова показало **Solana Mainnet** и предупреждение «reverted during simulation»; запрос отменён. **Вывод: MetaMask не используется как devnet signer.** На devnet тестируем через CLI и Phantom/Solflare. MetaMask проверяем отдельно на Solana Mainnet с минимальной суммой, после того как devnet-контур пройден.

## Devnet deployment v2, 2026-09-23

| Поле | Значение |
|---|---|
| Program ID | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5` (не путать с CLI-кошельком `8xwj…`) |
| ProgramData | `H5evLv9yEPaSRacNTYv5y4Tjdj3gJByUgavwMg66xTBg`, max-len 430000 байт (запас ~20% к 356856) |
| Upgrade authority / payer | `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A` |
| Program keypair | только в WSL: `~/.config/solana/yield-v2/yield_vault_v2-program-keypair.json`, в репозиторий не попадает |
| Deploy tx | `4qTAtfVsv38m2rc1KyTQJoxjEWaKApX7bAtNXiX6ed2JjeFF23Ldrio2jCJRcksa1ZcJkWng456Sd7DjhhJoF26S`, slot 502852411 |
| Стоимость | 3.92809 → 1.74010 SOL: 2.1853 SOL rent programdata + ~0.003 SOL комиссий |
| Бинарник | sha256 `7da760b1…3100ba0`; дамп с devnet совпадает с локальной сборкой |

Старая программа `3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s` не обновлялась. `declare_id!`, `Anchor.toml` (localnet/devnet) и `web/src/idl/yield_vault.json` в этой ветке указывают на v2 ID; mainnet-запись в `Anchor.toml` оставлена старой.

### Security smoke на devnet: PASS

`V2_CLUSTER=devnet V2_PAYER_KEYPAIR=~/.config/solana/id.json tsx src/v2SecuritySmoke.ts`. Скрипт проверяет genesis и program ID, одноразовый owner получает 0.03 SOL переводом от payer (faucet под rate limit), в конце остаток возвращается. Тестовый mint создан скриптом, реальный USDC не использовался.

- Попытки агента вывести токен через `execute_protocol_cpi` и `execute_swap_cpi` отклонены с `Unauthorized`. **Оговорка:** Anchor `.rpc()` отклоняет их на preflight-симуляции, поэтому в сеть эти транзакции не попадают. Проверено поведение программы на devnet, но не отдельная landed-транзакция с ошибкой. Балансы Safe и атакующего до и после не изменились.
- Смена агента посторонним отклонена (preflight).
- Прошедшие транзакции (от старых к новым): Initialize `31xj61YrKfdAeNpXNBpkR55qcwFjoxbKteBgvS221z1cCny2BUxSUGGkpCvCU5E1AMCgnQ28NFkYSbePxmr4kPJA`, Deposit `2a7pZgecDV4ZC2BvEXLk7YRcqwLHD4p17cktY9TpyeFiThso3iwtg2MHxSCh5v3f6pjMAyY6KdbpTdW33vXuhGVH`, SetAgent(отзыв) `46KmhDwJADWHaq3MS1k3jndJeYqeYki2FE6rpzWG3CYWENoayPWxevESenJKPkZEpBQZ9sprznnp5nKeqafeDAW5`, SetAgent(новый) `3SmdUmdUnwf2TU5FH2AgMAUYvMsbwhgXehN8vwMJp1U1Ep4sR46qq5FfxeSaHAQcgCq2iZhh4KpMBUDZmRtqsu1B`, owner ExecuteProtocolCpi `3KpCtM9sv4LbfgQbEx9tgdvVZ76bAH8pRxfSWCFH5Xeto1x3e8EMHsay35nEMZPwgWpd3SmS8PJMADWNfVSqDSJb`, Withdraw (полный остаток) `3rmdun78WgS8UavfUPQGJiYB9W6R1JeTSQC1b8Jha6xEykF34u6ufnJiA54Bz2dXw8qkX9LYdNi9hmt9zHMrsydW`.
- Payer после теста: 1.72298 SOL. Прогон стоил ~0.017 SOL; в основном это rent тестового mint, ATA и Safe PDA, который остаётся заблокированным, потому что инструкции закрытия нет.
- Публичный `api.devnet.solana.com` часто отвечает 429. Для регулярных прогонов нужен собственный devnet RPC (Helius/Triton).

## MetaMask на Solana mainnet: проба, 2026-09-23

Маршрут `/v2/mainnet-probe` (только при `NEXT_PUBLIC_V2_LAB_ENABLED=1`). Проба проверяет genesis mainnet, собирает одну v0 memo-транзакцию и симулирует её. Затем запрашивает подпись MetaMask через wallet adapter, локально проверяет, что message не изменён и подпись Ed25519 валидна, и только после этого отправляет в сеть. Подтверждение ждём опросом `getSignatureStatuses`. Переводов SOL и токенов нет, стоимость — только комиссия (~0.000005 SOL). Публичный `api.mainnet-beta.solana.com` отвечает браузеру 403, поэтому запросы идут через серверный dev-прокси `/api/v2/mainnet-rpc` с белым списком методов (`V2_MAINNET_RPC_URL` переопределяет upstream). До пробы на `2twC…pcdj` в mainnet было 0 SOL; нужно ~0.003 SOL (комиссия + rent-минимум счёта). Результат: ожидается.

## CCTP Base Sepolia → Safe: подготовка, 2026-09-23

- Тестовый Safe на devnet создан `client/src/v2CctpSafeSetup.ts`. Owner — тестовый ключ `EqUQn6SFqAP3KWufjV2a65pxGYXm8DHhRaE2K9ermJdN`, файл только в WSL: `~/.config/solana/yield-v2/cctp-test-owner.json`. Safe `5KVyrYLuFAckzV6znptgW8MgK18wmGXQ9T2MNHixegrd`, USDC ATA `HBqtvYAvtZW8oj9H6L9zkaveyWMpk1opaV8TXwLtzfHD` (mint `4zMMC9…DncDU`, owner — Safe). Agent отозван (`Pubkey::default`), allowlist пуст. Initialize tx `5TSxsLeboa4fQvkvUGPbfh9sJ75X1KibVDaLvtAUvtvpr2Xx53Ft7JrsiNVW5AsELGqCUUgt4X3ZrQ34x8WHkL6f`.
- Маршрут `/v2/cctp?ata=<Safe ATA>`. Проверяет на devnet, что получатель — USDC ATA, владелец которого принадлежит v2-программе. MetaMask выбирается через EIP-6963 (`io.metamask`), потому что Phantom тоже внедряет `window.ethereum`. Страница переключает MetaMask на Base Sepolia, делает approve на точную сумму в TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` и вызывает `depositForBurnWithHook(amount, 5, ATA as bytes32, USDC 0x036CbD53842c5426634e7929541eC2318f3dCF7e, 0x0, maxFee, 1000, "cctp-forward" без создания ATA)`. Хэш burn сохраняется в localStorage; после перезагрузки страница продолжает опрашивать `iris-api-sandbox /v2/messages/6` (status, forwardTxHash) и баланс ATA.
- Комиссии на 2026-09-23: fast 1.3 bps + forward ~0.14 USDC. `maxFee` = bps с округлением вверх + forward ×1.2. При 2 USDC в Safe должно прийти не меньше ~1.83 USDC.
- `viem@2.47.6` добавлен в прямые зависимости `web` (раньше был только транзитивным).
- Нужно от пользователя: Base Sepolia USDC (faucet.circle.com) и немного Base Sepolia ETH на газ на EVM-адресе MetaMask. Результат: ожидается.

### MetaMask на Solana mainnet: результат, 2026-09-23 — PASS

- Две первые попытки не прошли. Путь `signTransaction` зависал после Confirm или возвращал `User rejected`. Путь `sendTransaction` адаптера падал с `WalletSendTransactionError`, потому что адаптер выводил chain из URL RPC, а наш прокси `127.0.0.1` превращался в `solana:localnet`. **Для MVP:** при работе через свой прокси или нестандартный RPC вызывать Wallet Standard `solana:signAndSendTransaction` напрямую с явным `chain: "solana:mainnet"`.
- После исправления в mainnet прошли:
  - Memo `4SDDGHvKaC7cg63ERqMbdN39pK6aA12QYM9XHadYGxqWc8zpHAVsi9aoD5jQP43iDy8zvX9uoYrdZVfGnqwPUiBj`;
  - перевод 0.001 SOL на `EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2`: `5awv4baieFGU4GViokBS5gX2fw2C6MZEidToUfBaKUti9pz7ZQ1bT3whKtdWoHuBdSSpdfLsYpdkWPssVikVpm84`.
- Баланс `2twC…pcdj`: 0.004 → 0.002989699 SOL (0.001 перевод + 10 301 lamports комиссий на две транзакции).
- Вывод: MetaMask Extension подписывает и отправляет Solana-транзакции нашего dapp на mainnet. Owner Safe на MetaMask возможен на mainnet. На devnet MetaMask по-прежнему не работает (три пробы показали Mainnet).

## Vercel prod для мобильной пробы, 2026-09-23

- Preview (`yield-ai-os-4ua0y809v-edbiz.vercel.app`) закрыт Vercel Authentication, поэтому с телефона не открывается.
- По решению пользователя ветка `codex/yield-ai-v2` выкачена в production проекта `edbiz/yield-ai-os-sol` через CLI: деплой `yield-ai-os-oifytj5p9-edbiz.vercel.app`, алиас `yield-ai-os-sol.vercel.app`. Пользователей у продукта нет.
- Build env для этого деплоя: `NEXT_PUBLIC_V2_LAB_ENABLED=1`, `NEXT_PUBLIC_V2_PROGRAM_ID=8xa1…z3D5`. Остальные prod-переменные не менялись, настройки проекта тоже.
- Последствия:
  - основное приложение на prod собрано с v2 IDL, чей program ID есть только на devnet, поэтому старые mainnet-функции Safe на prod не работают;
  - `/api/v2/mainnet-rpc` публично доступен (белый список методов, upstream — публичный mainnet RPC);
  - `/v2/lab` и `/v2/cctp` на prod отдают 404, потому что им нужен devnet RPC.
- Откат: `vercel promote yield-ai-os-96pxvp1ty-edbiz.vercel.app` (прежний prod-деплой) или обычный push в `main`.

### MetaMask Mobile, 2026-09-23 — PASS через встроенный браузер

- iOS, встроенный браузер MetaMask, `yield-ai-os-sol.vercel.app/v2/mainnet-probe`. MetaMask есть в Select Wallet, Solana-аккаунт `EfkWSg4bpCq4oKguJ3Z7k2RHdVe1jt587yWr1CmZ7Dtb` (другой аккаунт, не `2twC…`).
- **B (Wallet Standard `signAndSendTransaction`, `chain: solana:mainnet`)**: memo v0 подтверждён, finalized, `jx5tJDXh5Lp7cAggC2pk3sjSV57HEzqdX9rSzrM5JbE9kxzBz4vepfcubgeoACEUGBbE3M28TWhtwPa8NZEnYvK`.
- **A (`signTransaction`, отправляет страница)**: завис на «Waiting for wallet», как и на desktop.
- В Chrome на телефоне MetaMask в модалке не появляется. Для мобильного входа нужна deeplink-кнопка «Open in MetaMask» (`https://metamask.app.link/dapp/<host>/<path>`).
- **Ограничение для архитектуры:** с MetaMask рабочий путь только `signAndSendTransaction`. Транзакции, где нужна вторая подпись (серверный fee payer, co-sign агентом, частичная подпись), с MetaMask не проходят, пока не доказано обратное. Все owner-действия Safe нужно проектировать так, чтобы единственным подписантом и плательщиком был владелец.

- 2026-09-23: prod откачен на `yield-ai-os-96pxvp1ty-edbiz.vercel.app` (`vercel promote`). Сборка v2 на prod ломала депозиты в старые Safe (`Attempt to load a program that does not exist`: IDL указывал на `8xa1…`, которой нет в mainnet), а владельцам старых Safe нужно вывести средства перед закрытием `3Vtz…`. Мобильная проба MetaMask к этому моменту уже прошла. **Урок:** не выкатывать v2 на тот же prod-алиас, пока в старой программе есть средства; для v2 нужен отдельный Vercel-проект или домен.

## Desktop UX: перетаскивание активов (drag-and-drop)

Паттерн уже есть в текущем приложении (`web/src`) и в основном Yield AI. Для v2 на десктопе берём его как основной жест управления. На мобильных остаются кнопки и слайдер.

### Как устроено сейчас (без библиотек, нативный HTML5 DnD)

| Файл | Роль |
|---|---|
| `lib/dragAsset.ts` | Тип `DragAsset` (`mint`, `symbol`, `decimals`, `balance`, `rawAmount`, `logoURI`, `source: "wallet" \| "vault"`). Собственный MIME `application/x-yield-ai-asset`, поэтому чужие drag (файлы, картинки) игнорируются. Плюс `serialize`/`tryParse` с проверкой полей. |
| `components/DragContext.tsx` | Глобальное состояние «что сейчас тащат» (`active`, `beginDrag`, `endDrag`). Без провайдера хук возвращает no-op, и зоны просто не подсвечиваются. |
| `components/AssetRow.tsx` | Источник: `draggable`, только если `balance > 0`. В `onDragStart` кладёт payload в `dataTransfer` (свой MIME + `text/plain` как fallback) и в контекст. Сам ряд во время drag получает `opacity-40 scale-[0.98]`. |
| `components/DropZone.tsx` | Универсальная цель. Предикат `accept(asset)` проверяется и при наведении (подсветка), и при drop. Счётчик `enterDepth` убирает мигание при проходе над дочерними элементами. Render-prop отдаёт `{ isOver, isCompatible, isDragActive }`. Классы `compatible` (ring), `over` (ярче + `scale-[1.005]`), `incompatible` (`opacity-60`). |

Почему это «стильно» работает: в начале drag **все совместимые зоны на странице сразу подсвечиваются**, а несовместимые приглушаются. Пользователь видит, куда можно бросить, ещё до движения. Над зоной появляется пилюля с действием («Drop here to deposit» → «Release to prepare deposit»), которая увеличивается при наведении.

Текущие связки:
- кошелёк → карточка Deposit: **только заполняет форму** (актив и полный баланс), транзакции нет;
- Safe → Wallet Assets: **сразу** `withdrawAsset` на весь баланс;
- Safe → карточка Earn idea: сразу запускает стратегию (Kamino deposit или loop).

### Правила для v2

1. **Drop никогда не подписывает транзакцию сразу.** Он открывает подтверждение с предзаполненной суммой, которую можно уменьшить (по умолчанию весь баланс), и показывает получателя, комиссию и итог. Сейчас вывод на весь баланс одним броском — риск: достаточно случайного отпускания.
2. Карта жестов v2:
   - USDC кошелька → Safe: депозит;
   - USDC в Safe → карточка стратегии (Kamino USDC, ONyc): распределение. Drop открывает слайдер Kamino/ONyc, предзаполненный этим активом;
   - карточка стратегии → Safe: выход из позиции;
   - Safe → кошелёк: вывод.
3. **Одна подпись владельца.** MetaMask надёжно проходит только через `signAndSendTransaction` с явным `chain`. Действие, запущенное броском, должно собираться в транзакции, где единственный подписант и плательщик — владелец.
4. **У каждого броска есть кнопка-дубль** (клавиатура, доступность, тач). Нативный HTML5 DnD не работает на iOS Safari и в мобильных webview, включая браузер MetaMask Mobile, поэтому на телефоне drag не показываем.
5. Переносимость: код без зависимостей и не привязан к Solana (`mint` — просто строка). Его можно вынести в общий пакет для Solana и Aptos версий Yield AI. Если понадобится drag на тач-устройствах или сортировка, переход на `@dnd-kit` меняет только `AssetRow` и `DropZone`, контракт `DragAsset` остаётся тем же.

## Закрытие старой mainnet-программы `3Vtz…`: состояние на 2026-09-23

- Пустые ATA закрыты через `/v2/old-safe-cleanup`: Safe `BM8o…` (owner `Dr4f…`, 3 шт.) и `ArGS…` (owner `EP9f…`, 9 шт., Safe полностью пуст). Очередь: `CgEe…` (owner `ADuE…`, 9 шт., 0.018548 SOL); у владельца 0 SOL, нужно пополнить ~0.002 SOL на комиссию.
- `51LXn67sW97ERPCAoNhKFdgz1jfSavYHuasLHt4rYQ5R` — Anchor IDL-аккаунт программы, не Safe (0.0189 SOL, authority `8xwj…`). Закрывается `anchor idl close` перед закрытием программы. Настоящих Safe — 6.
- Позиции Jupiter Lend, vault 78 (SPYx/USDC, NFT `jv78`), прочитаны через `@jup-ag/lend` `getCurrentPosition`:
  - #838 в `BM8o…`: залог ≈ 0.003585 SPYx, долг ≈ 0.1404 USDC. **Открыта**, нужен repay и вывод залога.
  - #664 в `CgEe…`: залог ≈ 0.000149 SPYx, долг ≈ 0.0172 USDC. Долг ниже порога dust-repay ($0.10) в `jupiterBorrow.ts`, штатный full repay может отказать.
  - #663 в `CgEe…`: пустая.
- Прочие Safe с остатками: `4nby…` (owner `9XL5…`, 0.335 USDC), `8nWM…` (owner `A3sV…`, 0.3 USDC + пыль xStock), `Cjh6…` (owner `5KJv…`, пыль). Владельцы пока не опознаны.
- При закрытии программы необратимо теряется: всё, что осталось в Safe и позициях, плюс rent самих Safe и лишние lamports на их PDA (~0.1 SOL суммарно). Возвращается 2.5347 SOL (programdata) + 0.0189 SOL (IDL).

### Старая программа закрыта, 2026-09-23

Владелец решил бросить остатки (Safe `4nby…`, `8nWM…`, `Cjh6…`, позиции #838 и #664 — все адреса его). Закрытие выполнил пользователь скриптом из WSL (у агента вызов заблокирован разрешениями Claude Code):
- `anchor idl close` → IDL `51LXn67sW97ERPCAoNhKFdgz1jfSavYHuasLHt4rYQ5R` закрыт, +0.01891728 SOL;
- `solana program close 3VtzVhc9vFWb7GaV7TtbZ1nytGzqNsASShAHjiWEFp5s --bypass-warning` → +2.53469976 SOL;
- `8xwj…`: 2.615605898 → 5.169212938 SOL (сходится с точностью до 10 000 lamports комиссий двух транзакций).
- `solana program show` → «has been closed». Program ID `3Vtz…` больше не используется. Оставшиеся в Safe активы и rent PDA необратимо заблокированы.

### Prod = v2 (devnet), 2026-09-23

Старая программа закрыта, конфликта больше нет, поэтому v2 выкачена на тот же алиас `yield-ai-os-sol.vercel.app` (деплой `yield-ai-os-g1e0cd0jg-edbiz.vercel.app`). Build env: `NEXT_PUBLIC_V2_LAB_ENABLED=1`, `NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com`, devnet USDC `4zMMC9…`, `NEXT_PUBLIC_V2_PROGRAM_ID=8xa1…`. Страницы `/`, `/v2/lab`, `/v2/cctp`, `/v2/mainnet-probe` отвечают 200. Переключение на mainnet — после деплоя программы по roadmap. Дальнейший план — миграция в основной Yield AI (там уже подключён Phantom).

## Архитектура Safe v2 (состояние на 2026-09-23)

### Компоненты

```
 Solana-кошелёк владельца (Phantom / Solflare / MetaMask-Solana)
        │  одна подпись, владелец = единственный signer и fee payer
        ▼
 Web (Next.js, /v2/safe) ── собирает инструкции, симулирует, отправляет через
        │                   Wallet Standard signAndSendTransaction с явным chain
        ▼
 Программа yield_vault v2 (8xa1…, upgrade authority 8xwj… → Squads)
        │
        ├─ Safe PDA = ["vault", owner]   (account Vault: owner, agent, strategy, allowlist)
        ├─ ATA Safe для каждого mint     (authority = Safe PDA; USDC ATA создаётся при initialize)
        └─ протокольные позиции от имени Safe PDA (Kamino shares, ONyc — в будущем)

 EVM-кошелёк (MetaMask-EVM, позже любой EIP-6963) ── CCTP depositForBurnWithHook
        └─ Circle Forwarding Service минтит USDC прямо в USDC ATA Safe (без нашего bridge-контракта)
```

### Инварианты

1. **Вывести средства из Safe может только владелец.** Все инструкции, которые двигают токены или lamports наружу (`withdraw`, `withdraw_spl`, `execute_*_cpi`, `close_empty_token_account`, `withdraw_excess_lamports`, `close_safe`), требуют подписи `owner` и проверяют `has_one = owner` или seeds `["vault", signer]`. Получатель rent и lamports — всегда владелец.
2. **Агент сейчас ничего не может.** `agent` хранится, но ни одна инструкция его не принимает. Будущие действия агента — отдельные узкие инструкции (например, `kamino_deposit` / `kamino_withdraw`): фиксированная программа и дискриминатор, счета назначения принадлежат Safe, лимиты сумм, проверка балансов после. Generic CPI агенту не возвращаем.
3. **Любой может пополнить Safe.** Перевод в ATA Safe или lamports на PDA не требуют разрешения; именно так работает CCTP forwarding. Учёт ведётся по фактическим балансам счетов в сети, а не по счётчикам в контракте.
4. **Потерять доступ нельзя, даже закрыв Safe.** PDA детерминирован от владельца, а `initialize` переиспользует существующий USDC ATA. Повторная инициализация возвращает контроль над всеми оставшимися ATA и позициями.
5. **Одна транзакция — один подписант.** MetaMask поддерживает только `signAndSendTransaction`, а `signTransaction` зависает, поэтому схемы с fee payer со стороны сервера или co-sign агентом с MetaMask не работают. Всё, что делает владелец, укладывается в одну его подпись; действия из нескольких шагов пакуются в одну транзакцию.

### Инструкции по ролям

| Роль | Инструкции |
|---|---|
| Владелец | `initialize`, `deposit`, `deposit_spl`, `withdraw`, `withdraw_spl`, `set_agent`, `set_allowed_programs`, `execute_protocol_cpi`, `execute_swap_cpi`, `close_empty_token_account`, `withdraw_excess_lamports`, `close_safe` |
| Агент | нет (до узких инструкций Kamino/ONyc) |
| Любой | перевести токены или SOL в Safe (CCTP forwarding, обычный перевод) |

### Поток пользователя (MVP)

1. Подключение Solana-кошелька → UI выводит Safe PDA → `Create Safe` (rent Safe ≈0.0116 SOL — аккаунт резервирует место под allowlist из 64 программ — плюс USDC ATA ≈0.0015–0.002 SOL; на devnet 2026-09-24 итого ≈0.0131 SOL с комиссией. Платит владелец или спонсор через `create_safe_for`, rent возвращается владельцу при `close_safe`. UI показывает сумму из RPC и блокирует создание, если SOL не хватает).
2. Пополнение: USDC с Solana-кошелька (`deposit`) или USDC с EVM через CCTP прямо в ATA Safe.
3. Размещение (следующий этап): Kamino USDC / ONyc по слайдеру, выполняется агентом через узкие инструкции или владельцем через CPI.
4. Выход: вывод всех holdings, затем «Close empty accounts» и «Close Safe» — всё возвращается владельцу.

### Кошельки

| Кошелёк | Devnet | Mainnet | Способ |
|---|---|---|---|
| Phantom / Solflare | да | да | Wallet Standard `signAndSendTransaction` |
| MetaMask Extension (Solana) | **нет** (всегда показывает Mainnet) | да, проверено 2026-09-23 | `signAndSendTransaction` + `chain: solana:mainnet` |
| MetaMask Mobile | нет | да, во встроенном браузере MetaMask | то же; из Chrome на телефоне нужна deeplink-кнопка |
| Rabby и другие EVM-only | — | только EVM-сторона (CCTP) | нет Solana-аккаунта, Safe создать не может |

### EVM-кошельки в будущем: что закладывать в контракт

**Вариант A (сейчас и рекомендуемый для MVP): EVM — только источник денег.** Владелец Safe — Solana-ключ; у пользователей MetaMask он есть в том же аккаунте. EVM-кошелёк подписывает CCTP burn, USDC приходит прямо в ATA Safe. Связь `0x` ↔ Solana-адреса при необходимости подтверждается двумя подписями одного сообщения (EIP-191 + ed25519) и хранится вне сети. **Изменений в контракте не нужно.** Любой EVM-кошелёк (Rabby, Coinbase и т.д.) подключается выбором через EIP-6963 на странице CCTP.

**Вариант B (позже, если нужны пользователи только с EVM): Safe, которым владеет EVM-адрес.** Отдельное пространство PDA `["vault_evm", eth_address20]` и отдельный набор инструкций, авторизуемых secp256k1-подписью (EIP-712, domain = программа + cluster, nonce в аккаунте) через нативную программу `Secp256k1SigVerify` и introspection sysvar инструкций. Такой пользователь не держит SOL, поэтому транзакции отправляет relayer (fee payer). Это значит: спонсорство комиссий, защита relayer от злоупотреблений и отдельный аудит. **Существующие Safe это не затрагивает** — B добавляется новыми инструкциями и новым типом аккаунта через апгрейд, миграция не нужна. Резервировать поля в `Vault` сейчас незачем.

**Вариант C: кросс-чейн сообщения (Wormhole / LayerZero).** Действия авторизуются на EVM-стороне и доставляются в программу сообщением. Тяжелее B, зависит от внешней инфраструктуры. Не рассматриваем.

**Что стоит решить до mainnet (дёшево сейчас, дорого потом):** спонсируемое создание Safe — инструкция `create_safe_for(owner)`, где rent платит relayer, а подпись владельца не нужна (PDA всё равно привязан к owner). Она убирает требование «иметь SOL, чтобы создать Safe» для пользователей, пришедших с EVM через CCTP, и совместима с MetaMask (владелец ничего не подписывает). Открытый вопрос: кому возвращать rent при `close_safe` — владельцу (проще, relayer теряет ~0.006 SOL на Safe) или плательщику (нужно хранить `rent_payer` в `Vault`). Решение за пользователем.

### Конфигурация web

- `NEXT_PUBLIC_PROGRAM_ID` в переменных prod-проекта Vercel всё ещё указывает на закрытую `3Vtz…`; сборки v2 переопределяют её через `--build-env NEXT_PUBLIC_PROGRAM_ID=8xa1…`. Переменную в проекте стоит обновить (настройка проекта — решает владелец).
- Prod `yield-ai-os-sol.vercel.app` = v2 на devnet; `/v2/safe` — основной UI Safe.

## Allocation в контракте и спонсируемое создание Safe, 2026-09-23

- `strategy` (enum, задавался только при `initialize`, нигде не проверялся) заменён на `allocation_bps: [u16; 8]`: целевые доли владельца по маршрутам (`ROUTE_KAMINO_USDC = 0`, `ROUTE_ONYC = 1`, остальные зарезервированы), сумма ≤ 10 000, остаток — свободный USDC. `initialize(agent, allocation_bps, allowed_programs)` и `set_allocation(allocation_bps)` проверяют сумму (`AllocationTooHigh`); `set_allocation` — только владелец. Будущие инструкции агента обязаны укладываться в эти доли — это граница безопасности агента, а не просто настройка UI.
- `create_safe_for(owner)`: любой плательщик создаёт Safe для `owner` без его подписи; только безопасные значения по умолчанию (агента нет, allowlist пуст, allocation нулевой). Повторное создание невозможно (`init`). Rent при `close_safe` уходит **владельцу** (решение пользователя: проще, relayer теряет ≈0.013 SOL на Safe; уменьшить можно, сократив резерв allowlist с 64 программ).
- Тест `v2-security` дополнен: allocation (запись, >100% отклоняется, посторонний отклоняется), `create_safe_for` (поля по умолчанию, двойное создание отклоняется, весь rent — владельцу без SOL). **PASS локально и на devnet** 2026-09-23. Devnet-апгрейд `uDbuYNj3Gucah4DWzvm2RFSVoDdiaZCVAAy7c8TA685KdKXKazauhvCNjpyZXaJU6xHTvdFvqgWMLASBsXzPFDT`, slot 503030770, sha256 `9d0ca7a6…e8fa1f8d` совпадает с локальной сборкой; бинарник 405 888 байт при max-len 430 000 — для mainnet брать max-len с запасом (≈600 000).
- Совместимость: Safe, созданные до смены раскладки (на devnet: `5KVy…`, `ALaZ…`, `2VP1…`), читаются с мусорным allocation; `owner`/`agent` на прежних местах, поэтому проверки владельца, вывод и `close_safe` работают. UI распознаёт такой Safe (сумма > 10 000) и предлагает сохранить allocation — `set_allocation` на старой раскладке проверен симуляцией на devnet.
- Web: `/v2/safe` получил карточку Allocation (слайдеры Kamino USDC / ONyc, остаток — idle USDC, сохранение через `set_allocation`). Устаревший ребалансер и чат-агент читают любой Safe как Conservative: в v2 они всё равно не могут исполнять (CPI только владельцу) и будут заменены узкими инструкциями.
- Индекс Safe (`["vault", owner, id]`) отложен.

## Allowlist 16 и vanity-адрес для mainnet, 2026-09-24

- `MAX_ALLOWED_PROGRAMS` и `#[max_len]` сокращены с 64 до 16. Аккаунт Safe: 661 байт вместо 2 149; rent на devnet 0.00401 SOL вместо 0.01157. Создание Safe с USDC ATA и комиссией ≈ 0.0055 SOL (было ≈ 0.0131). Легаси `initializeVault` передаёт пустой allowlist (в `DEFAULT_ALLOWED_PROGRAMS` 18 программ — больше предела).
- Тест дополнен: allowlist из 17 программ → `TooManyPrograms`, из 16 — проходит. PASS локально и на devnet: апгрейд `4dy7PDAC2CkSuw1Qtsy8c1iqJeupSXERcSJUAPFLoCZAKH1BhhP87rVMXVuNd8vgxL77LXzXBCikCwgA1kk8wf1w`, slot 503111653, sha256 `6b67d0bd…7276eaad` совпадает со сборкой. Старые Safe на devnet (2 134 байт) продолжают работать: Anchor читает структуру из более длинного буфера, `set_allowed_programs` уменьшает аккаунт через realloc.
- Vanity program ID для mainnet: **`yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`** (`solana-keygen grind --starts-with yie1:1`, 22 потока, 394 млн ключей за 1 541 с). Keypair только в WSL: `~/.config/solana/yield-v2/vanity/yie1Jjq6….json` (права 600). Для mainnet-сборки нужны `declare_id!` и `Anchor.toml [programs.mainnet]` на этот ID — devnet-сборка остаётся на `8xa1…`.
- `yie1d…`: на 5 символов ожидаемо ≈58× больше ключей. При скорости ≈255 тыс. ключей/с это порядка суток с большим разбросом; одной ночи может не хватить.

## Kamino USDC route: узкие инструкции агента, 2026-09-24

**Контракт.** `kamino_deposit(amount)` и `kamino_withdraw(shares, from_reserve)` — вызывает владелец или агент (`agent ≠ default`). Контракт сам собирает данные CPI (дискриминатор + сумма), поэтому вызвать другую инструкцию kVault нельзя. Проверки:
- программа — только kVault `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd`, `vault_state` — только Kamino USDC kVault `91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy`;
- `user` в инструкции kVault — PDA Safe (подпись через `invoke_signed`);
- `user_token_ata` и `user_shares_ata` должны быть токен-счетами SPL / Token-2022, чей authority — PDA Safe (`NotSafeTokenAccount`). Деньги ходят только между счетами Safe и kVault: вывести наружу агент не может;
- депозит: `allocation_bps[ROUTE_KAMINO_USDC] > 0` (`RouteDisabled`) и `amount ≤ свободный USDC Safe × bps / 10 000` (`AllocationExceeded`);
- вывод: `from_reserve = false` → `withdraw_from_available` (14 счетов + remaining), `true` → полный `withdraw` с группой счетов резерва (25 + remaining). Позиции счетов сверены с on-chain IDL kVault.

**Ограничение (известное).** Лимит считается от свободного USDC за один вызов: серия депозитов может постепенно превысить цель (60% от 100, затем 60% от остатка и т.д.). Кражу это не открывает (деньги остаются в Safe/kVault, владелец выводит в любой момент), но точное соблюдение доли требует оценки позиции в kVault ончейн (shares × AUM / supply) — следующий шаг.

**Тест на форке mainnet** (`client/src/v2KaminoFork.ts`, `solana-test-validator` с клонами программ kVault/klend и 12 аккаунтов USDC kVault из mainnet; USDC владельцу — подготовленный токен-аккаунт через `--account`). PASS 2026-09-24:
- депозит 60.000001 USDC при цели 60% от 100 → `AllocationExceeded`;
- shares на счёт атакующего → `NotSafeTokenAccount`; вызов посторонним → `Unauthorized`; вывод USDC на счёт атакующего → `NotSafeTokenAccount`;
- агент вносит 60 USDC → 56 785 434 shares в Safe, 40 USDC свободно; агент выводит все shares → 99.998995 USDC в Safe; **стоимость круга 0.001005 USDC** (округление shares в пользу kVault); владелец забирает всё.
- Не проверено: полный `withdraw` из резерва (`from_reserve = true`) — на форке хватило свободной ликвидности; Kamino farms (награды) не подключены.

**Devnet.** Kamino на devnet нет, поэтому там только регрессия. Программа расширена до 630 000 байт (`solana program extend`, ≈1.0 devnet SOL rent), апгрейд `22E1mFYi1JKgFZG2gwamVYMBaP1qzHuJU8oo18SAR5GAjiZ4wqF8NBcZEm47uFoBFCPRxD74BAQxVCf4rm3B9Kyo`, slot 503123371, sha256 `0c36559f…eb6fb3f2` совпадает со сборкой (435 944 байт). `v2-security` PASS.

**Для mainnet-деплоя:** бинарник 436 КБ; max-len брать ≈650 000 (≈4.5 SOL rent) или деплоить с запасом и расширять по мере роста.

## Performance fee: 5% с реализованной прибыли, 2026-09-24

**Модель.** Как на Aptos (5% с дохода), но взимается ончейн в момент выхода из маршрута. Пула и долей нет, поэтому комиссия считается по каждому Safe отдельно.

**Контракт.**
- `Config` PDA `["config"]`: `admin`, `treasury` (кошелёк, чей USDC ATA получает комиссию), `performance_fee_bps`. Жёсткий потолок `MAX_PERFORMANCE_FEE_BPS = 2 000` (20%) — admin не может поднять выше.
- `init_config(treasury, fee_bps)` — только upgrade authority программы: `program_data` = PDA загрузчика от ID программы, authority читается из байтов ProgramData (без `Account<ProgramData>`: bincode добавлял ≈58 КБ к бинарнику). Защищает от перехвата admin сразу после деплоя. `set_config(admin, treasury, fee_bps)` — только текущий admin (передача на Squads — `set_config` с новым admin).
- `Vault.route_principal: [u64; 8]` (добавлено в конец структуры, смещения прежних полей не меняются) — cost basis владельца по маршрутам.
- `kamino_deposit`: principal += фактически ушедший из Safe USDC (баланс до − после CPI).
- `kamino_withdraw` (новые аккаунты: `config`, `treasury_usdc_ata`, `token_program`): `principal_out = principal × shares / shares_before`, прибыль = полученный USDC − `principal_out`, комиссия = прибыль × fee_bps. Убыток — без комиссии. Комиссия переводится PDA Safe только на токен-счёт, чей владелец = `config.treasury` и mint = USDC Safe (`InvalidTreasury`). Событие `RouteExit {vault, route, received, principal_out, fee}` для учёта и UI. `shares > баланс` → `InsufficientShares`.
- `execute_protocol_cpi` / `execute_swap_cpi` запрещают программу kVault (`UseDedicatedInstruction`): иначе владелец мог бы обойти комиссию и сбить учёт principal. Выход владельца из Kamino остаётся через `kamino_withdraw`.

**Проверки.**
- Rust-юнит-тесты `realize_exit` (полный выход с прибылью, убыток, частичный выход пропорционально, позиция без cost basis, нулевая ставка) — 6/6.
- `v2-security` PASS локально и на devnet: `init_config` посторонним → `Unauthorized` (атакующий пополнен SOL, чтобы отказ был именно по authority), комиссия > 20% → `FeeTooHigh`, `set_config` не-админом → отказ, generic CPI в kVault → `UseDedicatedInstruction`.
- Форк mainnet PASS: principal после депозита = 60 000 000; после полного выхода principal = 0, казна получила 0 (круг −0.001005 USDC); вывод > shares Safe → `InsufficientShares`.
- **Не проверено сквозным тестом:** реальный перевод комиссии в казну при прибыли — на форке за время теста доход не начисляется. Покрыт юнит-тестом расчёта; путь перевода и проверки казны выполнятся впервые при первой прибыльной позиции — проверить на mainnet малой суммой.

**Devnet.** Апгрейд `5x4n9pnmfj2o2HpPehZnbfjkFyq6cQW6gSqhfQ2YdxqwH1ThihYvJk7VdihM7DL79BxA3Ev1svY341225EJW1eU6`, slot 503133118, sha256 `df559b9c…0988ef043` совпадает со сборкой. Config `5EjWRU9zFsSH6QavNVB7KpoqrYDHrt7w53Kk8XR5RX1`: admin и treasury `8xwj…`, fee 500 bps.

**Размер.** Бинарник 481 832 байт. Для mainnet: max-len ≈ 560 000 (≈3.9 SOL rent) или больше с запасом; на `8xwj…` 5.17 SOL.

## UI: Kamino USDC из /v2/safe, 2026-09-24

**Что добавлено.**
- `GET /api/v2/kamino?op=metrics` — APY, `tokensPerShare`, `tokensAvailable` USDC kVault; `op=deposit|withdraw&owner=&amount=` — счета kVault-инструкции от Kamino API для PDA Safe этого владельца (проверяются программа, `user` = Safe, `vault_state` = USDC kVault; неверный owner/amount → 400). Данные инструкции контракт собирает сам, отсюда берутся только счета и lookup tables.
- `safeV2.ts`: `ixKaminoDeposit` (идемпотентное создание ATA shares Safe за счёт владельца + `kamino_deposit`), `ixKaminoWithdraw` (идемпотентное создание USDC ATA казны + `kamino_withdraw`; вариант вывода — по дискриминатору от API), `loadLookupTables`, `routePrincipal` в `readSafe`; отправка поддерживает lookup tables.
- Карточка **Kamino USDC**: позиция (shares × tokensPerShare), вложено (principal), цель, APY; «Put X USDC to work» (X = свободный USDC × доля Kamino, минимум 0.001) и «Withdraw all from Kamino». Всё — одна подпись владельца. Вне mainnet кнопки неактивны с пояснением. Shares скрыты из Holdings.

**Контракт: закрыты обходы комиссии.** Shares USDC kVault (`B9t9…`) не проходят через `deposit`, `withdraw`, `deposit_spl`, `withdraw_spl` (`UseDedicatedInstruction`); универсальный CPI отклоняется, если среди его счетов есть канонический ATA shares Safe; `kamino_*` требуют именно этот канонический ATA. Бинарник 488 056 байт.

**Проверки (2026-09-24).**
- Форк mainnet, `v2KaminoFork.ts`: плюс три попытки обхода владельцем (`withdraw_spl` shares, `withdraw` с mint shares, CPI-перевод shares) — все отклонены; остальное без изменений. PASS.
- Форк mainnet, `web/scripts/kamino-ui-fork.ts` — **те же сборщики, что вызывает страница**, только подпись владельца: create Safe → allocation 60% → deposit 100 → Kamino deposit 60 (56 781 421 shares, principal 60) → withdraw all (shares 0, principal 0, 99.998995 USDC). Транзакции 833 и 966 байт — укладываются в лимит и без lookup table. PASS.
- `/api/v2/kamino` на локальном dev-сервере: metrics, deposit (17 счетов + LUT `6nfiQm8U…`), отказы на неверные owner/amount. PASS.
- Devnet: апгрейд `4p4rDWGXNQ2x6SLLYgrp56KdTbqB5pAfQofoLMPhorj2ECnxc6HZtUgbssmsbxYgGEWqZrh8xUeu1uBofbwnGJQ3`, sha256 `1734104b…98ba7b83` совпадает; `v2-security` PASS.

### Вывод из инвестированного резерва: локальный форк, 2026-09-24

Kamino KTX API отдавал только `withdraw_from_available`, что не проверяло путь выхода после `invest`. Серверный `/api/v2/kamino?op=withdraw&owner=&shares=<raw>` теперь использует официальный `@kamino-finance/klend-sdk@12.0.0`: читает активные резервы и shares Safe, строит одну или несколько инструкций полного выхода и сверяет Safe, vault, mint, ATA и дискриминатор. Клиент оборачивает каждую инструкцию в ограниченный `kamino_withdraw`. Контракт поддерживает `u64::MAX` на последнем шаге и считает principal/fee по фактически погашенным shares. Путь с фармом не включён: Safe хранит shares в своём ATA.

**PASS на локальном форке mainnet:** клонированы оба резерва и oracle USDC kVault; Safe получил 100 тестовых USDC, внёс 60 в Kamino, локальный `invest` уменьшил свободный баланс kVault с 71.329570 до 26.223325 USDC. SDK выбрал полный `withdraw` из резерва; после симуляции и отправки одной транзакции 706 байт shares = 0, route principal = 0, Safe USDC = 99.998994. Круг стоил 0.001006 USDC. Rust unit-тесты 6/6 и TypeScript `tsc --noEmit` прошли. Скрипты: `web/scripts/kamino-full-exit-prepare.ts`, `web/scripts/start-kamino-fork.sh`, `web/scripts/kamino-ui-fork.ts`.

**Дополнительный прогон 2026-09-25:** при повторном снимке Kamino отклонил локальный `invest` ошибкой `InvestTooSoon` (его временной лимит). Отдельный прогон с `KAMINO_SKIP_INVEST=1` проверил отказ на подменённый USDC ATA получателя, погашение shares из доступной ликвидности и финальный перевод всего USDC из Safe владельцу: баланс USDC Safe стал нулевым. Это не заменяет предыдущий успешный тест выхода из инвестированного резерва. Транзакции в обоих прогонах были только на локальном валидаторе.

`/v2/safe` по умолчанию показывает одну оценку стоимости в USDC, частичный вывод свободного USDC, кнопку полного вывода и прямой owner-signed вход в Kamino из свободного USDC Safe или из USDC кошелька через Safe в одной атомарной транзакции. Для частичного вывода владелец вводит сумму USDC или процент от свободного USDC; поля синхронизируются, `Max` выбирает 100%, и одна owner-signed транзакция вызывает `withdraw(amount)` после симуляции. Это не доля от оценочной стоимости с Kamino: вложенные средства сначала нужно погасить. Если shares в Kamino есть, полный вывод получает свежий план перед каждым шагом, подписывает по одной транзакции на шаг, затем читает фактический баланс и переводит весь оставшийся USDC владельцу. После прерывания пользователь может повторить действие с текущего on-chain состояния. Требуется несколько подтверждений кошелька; точная сумма известна только после погашения и комиссии. Настройка allocation и дополнительные Kamino-контролы доступны лишь при `NEXT_PUBLIC_V2_LAB_CONTROLS=1` для технического теста; отдельный вывод других токенов остаётся доступным, если они есть в Safe. Закрытие Safe теперь заблокировано и при ненулевых Kamino shares. ONyc и другие активы в полном выводе пока не поддерживаются. Детали owner-депозита и плана executor — в [отдельном документе](yield-ai-v2-executor.md).

`npm run build` прошёл после подключения Kamino SDK; финальная правка проверки метрик и отображения других токенов прошла `tsc --noEmit` в WSL. Во время статической генерации внешние RPC отвечали 429 и Next повторял запросы, но сборка завершилась с кодом 0. Trace API-маршрута Kamino содержит около 20 900 файлов / 117 MiB до упаковки; размер serverless-функции и peer-зависимости SDK требуют отдельной проверки в preview перед деплоем.

Остаётся обязательная проверка малым объёмом в mainnet после отдельного согласования транзакций и деплоя v2: депозит → реальный `invest` → полный вывод, включая положительную прибыль и фактический перевод fee в treasury. До этого нельзя считать выход для пользователей подтверждённым в mainnet.

### Следующий контрактный срез: выбор vault оператором

Текущая реализация принимает **один фиксированный USDC kVault**. Скрытие слайдера в UI не создаёт поддержку нескольких vaults. Для расширения нужен отдельный on-chain список разрешённых vaults под управлением admin/Squads: адрес kVault, shares mint, базовый USDC mint, статус входа и выхода, лимит экспозиции и версия проверенного layout. Доступ к институциональному vault или его условия должны быть подтверждены отдельно; адрес в списке сам по себе не означает, что Safe сможет внести и вывести средства.

Для каждого Safe и vault нужен отдельный учёт shares и principal, чтобы прибыль и комиссия 5% считались по фактически погашенным shares именно этого vault. Агент сможет переложить активы только через выход в USDC Safe и новый вход в другой разрешённый vault. Владелец всегда может остановить агента и инициировать выход из каждого vault. Пользовательский экран суммирует idle USDC и проверенные оценки всех позиций; если цена одной позиции недоступна, общая оценка должна быть помечена как неполная. Полный вывод перебирает все ненулевые позиции и затем переводит фактический USDC владельцу, возобновляясь после каждого подтверждённого шага.

Добавление каждого нового vault — отдельная проверка инструкции и аккаунтов, ограничений доступа, ликвидности, успешного полного выхода после `invest`, стоимости операций и положительной прибыли/fee. В интерфейсе владелец по-прежнему видит одну текущую стоимость и действие «вывести всё»; управление списком и выбором vault не выдаются владельцу как обязательный шаг. Этот срез ещё **не реализован** и не должен считаться покрытым текущим локальным тестом одного vault.

### Executor whitelist для Safe: реализован локально, Mainnet upgrade ожидается

Для текущего индивидуального Safe добавлен отдельный `ExecutorRegistry` PDA под управлением `Config.admin`: до 16 approved Solana-адресов и один default. Админская страница `/v2/admin/executors` подписывает создание и замену списка админским кошельком. Пустой default приостанавливает создание Safe через UI. Адрес executor хранится on-chain; пользователь не выбирает его и не видит дополнительного шага.

При обычном создании Safe владелец одной транзакцией подписывает `initialize` с текущим default. Контракт требует, чтобы key был ненулевым и входил в whitelist. Смена default не меняет полномочия уже существующих Safe без подписи владельца; UI предлагает owner-signed «Update executor». Админский отзыв ключа действует сразу на agent-signed Kamino вход и выход в каждом Safe. Owner-signed вывод и восстановление остаются доступными. Sponsored `create_safe_for` пока создаёт Safe без executor, поскольку владелец не подписывает передачу полномочий. Это исключение не используется обычной кнопкой создания.

Executor получает только ограниченные инструкции Kamino с проверками маршрута и allocation, не generic CPI и не прямой перевод USDC. Сервис исполнения ещё не запущен; назначение адреса само по себе не запускает сделки. Для пилота создан **новый отдельный executor key** в WSL с публичным адресом `3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH`; он уже назначен default в Mainnet registry и в Safe `FuDC…`. Приватный файл имеет права `0600` и не должен попадать в фронтенд, Git или документацию.

Локальный security smoke подтвердил admin-only управление, отказы при невалидном списке и нулевом/чужом key, отзыв ранее назначенного executor и owner recovery. Локальный Kamino fork подтвердил agent-signed вход 60 тестовых USDC и полный выход. Сборка `536904` байт (`37bcd17d1a92fe05665eed207e5a0167062c886dc3efa6df28cbbbb99a307042`) **развёрнута в Mainnet 2026-09-26** после расширения ProgramData. Registry с `3ayNPp…` создан и прочитан on-chain. Владелец создал Safe `FuDC…` и внёс 2 USDC; реальный Kamino round trip и Production-переключение ещё не выполнялись. Подписи, стоимость и следующие проверки — в [Mainnet preflight](yield-ai-v2-mainnet-preflight.md).
