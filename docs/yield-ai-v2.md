# Yield AI v2 — Colosseum MVP

Status: implementation started in the isolated `codex/yield-ai-v2` worktree on 2026-09-23. This document describes the intended product and records which acceptance gates have actually passed. A green local test does not imply a devnet deployment or a safe mainnet upgrade.

## Product boundary

One user controls one personal Solana Safe PDA. The first deposit asset is native Solana USDC. A mobile user connects MetaMask, deposits USDC, selects a split between Kamino USDC, ONyc and unallocated USDC, sees actual holdings and total value in USDC, and can unwind the positions and receive all available USDC. There is no pooled share token in this MVP.

The owner key for the first implementation is the **Solana public key exposed by MetaMask**, not the EVM `0x` address. The EVM address is used only for a separately authenticated EVM deposit and cross-chain transfer. A user must explicitly sign a challenge with both keys to link them; the app must not infer ownership from MetaMask showing both addresses in one account. If EVM-only recovery is required, it needs a separate contract authorization design.

JLP, JLP Multiply, xStock/USDC LP and stock Multiply are future routes. They must not enter the initial risk slider or automatic execution until their own full-cycle exits and economics have been tested.

## Baseline findings

- The original `execute_protocol_cpi` and `execute_swap_cpi` gave the agent arbitrary instruction data and accounts while `invoke_signed` gave the inner program the Safe PDA signature. The allowlist includes SPL Token, Token-2022 and System Program, so it was not a fund-preservation boundary.
- The existing `client/src/smoke.ts` checks only initialize, direct deposit and a partial direct withdrawal. It does not test agent authority, protocol receipt tokens, or a full exit.
- The web wallet provider explicitly lists Phantom and Solflare. MetaMask Solana ownership-message signing worked in the desktop extension, but devnet transaction signing failed the network-display gate twice. MetaMask documents Solana devnet support for its browser extension only; mobile currently supports Solana mainnet only.
- Existing Kamino building uses `https://api.kamino.finance` and mainnet program IDs. The Jupiter swap builder rejects devnet. These integrations need a cluster-specific fixture or a small mainnet test after the Safe gate; a devnet Safe test cannot establish their production behavior.
- The main checkout contains unrelated uncommitted contract, IDL, adapter and document changes. This worktree starts from commit `d5fc213` and does not copy those changes. In particular, the main checkout's draft lamport-refund and empty-token-account-close instructions are absent here.

## First security slice in this branch

The two generic CPI entrypoints are restricted to the Safe owner. This deliberately disables current agent automation until each intended action has a constrained on-chain instruction. The owner can rotate the agent or set it to the default pubkey to revoke access. This change preserves the existing `Vault` account layout, but it changes the behavior of an existing instruction and must not be deployed as an unreviewed upgrade to the live program. A new v2 program ID and a migration plan are required before devnet deployment.

`client/src/v2SecuritySmoke.ts` is a local-validator regression: it deposits a test SPL token, attempts to transfer it from the Safe to an attacker through both generic CPI entrypoints using the agent signature, checks balances, rejects non-owner agent rotation, checks owner revocation and rotation, then returns part of the deposit via owner-signed CPI and withdraws the rest directly. This is a transaction test script; do not point it at mainnet. It passed on a local validator with disposable in-memory keys on 2026-09-23.

`/v2/lab` is a devnet-only, opt-in wallet probe. It verifies a Solana ownership-message signature against the selected public key using WebCrypto Ed25519. A no-broadcast v0 memo probe is available for non-MetaMask Wallet Standard wallets when they declare solana:devnet and v0 support, the RPC genesis matches devnet, and the address has at least 0.001 devnet SOL. MetaMask transaction signing is disabled after its popup showed Mainnet even with an explicit devnet chain request. The lab displays the selected Solana address, wallet-declared chains, balance, and derived PDA when a separate v2 program ID is configured. Enable it with NEXT_PUBLIC_RPC_URL pointing to devnet and NEXT_PUBLIC_V2_LAB_ENABLED=1; set NEXT_PUBLIC_V2_PROGRAM_ID once deployed. Record the selected wallet, address, capabilities and exact success/failure. If a browser lacks WebCrypto Ed25519, the probe reports that error rather than claiming verification.

### Agent permission design still required

The intended agent actions are narrowly named Kamino deposit/withdraw and, later, ONyc buy/sell. Each instruction needs exact program and instruction checks, fixed destination ownership, mint/vault checks, amount bounds, and post-action balance or shares invariants. The owner must be able to revoke the agent immediately. Generic CPI access must never be restored to the agent as a shortcut. A backend quote or allowlist alone cannot enforce custody.

## Acceptance gates

| Gate | Test and pass condition | State |
| --- | --- | --- |
| 0. Contract authority | Agent cannot transfer USDC/SOL to a third party via either generic CPI; non-owner cannot rotate agent; owner can revoke and withdraw all direct tokens. | Passed on a local validator on 2026-09-23; devnet still pending. |
| 1. Wallet signing | A supported wallet exposes the expected Solana address, signs an owner challenge and Safe transaction on the selected cluster, rejects a changed network or account, and reconnects to the same Safe. Verify the actual mobile wallet separately. | Desktop MetaMask ownership-message signature verified. Two desktop extension v0 memo requests displayed Mainnet; the second used chain=solana:devnet and was cancelled. No devnet transaction signed or sent. MetaMask transaction signing is disabled in the lab. Official MetaMask Connect Solana with its devnet CAIP-2 scope is the next extension integration to investigate; MetaMask Mobile is documented as Solana mainnet only. |
| 2. Devnet Safe | Separate v2 program ID; test USDC mint and cluster checked; simulate, then initialize, deposit and full direct withdrawal. Record signatures, balance deltas, fees and rent. | WSL build passed; separate v2 program ID, devnet simulation and transactions pending. |
| 3. Circle CCTP | Base Sepolia test USDC burn, attestation and Solana Devnet mint to the intended receiver; resume after app close or interrupted relay; no double credit. Bridge status is keyed by source transaction and message ID. | Pending. |
| 4. Kamino from Safe | Confirm a suitable kVault on the selected cluster; deposit from Safe PDA, record shares, withdraw all shares, reconcile USDC and rent. A normal-wallet transaction does not pass. | Pending cluster availability and constrained instruction. |
| 5. ONyc exit | Quote and execute USDC→ONyc→USDC at several sizes; enforce min-out, stale quote and liquidity limits; reconcile actual proceeds against displayed value and NAV. | Pending mainnet market test. |
| 6. Full product exit | Stop new allocation, unwind Kamino, sell ONyc within user-approved bounds, transfer all available USDC and show any dust or failed step. Retry resumes from observed chain state. | Pending. |
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
5. Add the allocation slider and secondary-market ONyc route only after executable sell quotes and a full exit test. Display actual balances and costs; slider percentages are targets, not guaranteed final holdings.

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
