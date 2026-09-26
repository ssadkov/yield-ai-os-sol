# Yield AI v2 — развёртывание программы и подготовка Mainnet (`yie1…`)

Исторический preflight начат 2026-09-25. **Программа развёрнута и `init_config` выполнен в Mainnet 2026-09-26; Mainnet Safe, пилот с USDC и Production-переключение ещё не выполнены.** Рабочая ветка `codex/yield-ai-v2-mainnet` создана от `codex/yield-ai-v2` (`84f3aac`); основной checkout `C:\work\yield-ai-os-sol` не изменялся. Состояние ветки следует перепроверить перед выпуском.

## Адреса и текущая сеть

**Обновление executor whitelist (2026-09-26):** код и локальные тесты готовы, но текущий Mainnet байткод его ещё не содержит. Текущий закрытый Preview остаётся на прежнем контрактном интерфейсе до отдельного upgrade и инициализации registry. Подробности в разделе «Executor whitelist» ниже.

| Объект | Адрес / результат read-only проверки |
|---|---|
| Mainnet program ID | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`; исполняемая upgradeable программа, deploy slot `450553234` |
| Mainnet config PDA | `8MzeS2fxHGw35et7rQAqA4TJ8mw7p7CMP1rH1C5iRbk2`; создан, admin и treasury `8xwj…`, performance fee `500 bps` |
| Vanity keypair | хранится только в WSL Ubuntu `~/.config/solana/yield-v2/vanity/`; `solana-keygen pubkey` совпал с `yie1…`; секрет в репозиторий и лог не копировать |
| Devnet program | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5`; остаётся отдельной программой |
| Владелец, подтвердивший Devnet Safe | `EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2` |
| Его Devnet Safe | `28z3NpLQPSA3AdAUeFrko3fRm3BtdZTNcCmYe7yUYVy3`, аккаунт принадлежит `8xa1…` |
| Будущий PDA Safe этого же владельца под `yie1…` | `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ`; пока это только расчёт, Safe не создан |
| Mainnet SOL владельца на момент проверки | `0.082353123 SOL`; показанные интерфейсом `13.9704 SOL` относились к Devnet |
| Mainnet deployer/текущая upgrade authority | `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`; баланс после `init_config` `2.678346128 SOL` |

**Деньги:** Devnet Safe и Mainnet Safe — разные адреса на разных кластерах. Средства не переходят между ними. Текущий `https://yield-ai-os-sol.vercel.app/v2/safe` на момент проверки обслуживал Devnet (`8xa1…` и Devnet USDC `4zMMC9…`); использовать его для Mainnet USDC нельзя. Публиковать mainnet-профиль нужно отдельно, с явной проверкой RPC/genesis, program ID и mint в интерфейсе и кошельке.

## Что подготовлено в коде

- `declare_id!`, `[programs.mainnet]`, фронтенд-константа и сгенерированный Anchor IDL используют один `yie1…` ID. В IDL изменился также seed PDA `program_data` для `init_config`; простая замена верхнего поля `address` была бы недостаточной.
- Клиент останавливается при несовпадении настроенного program ID с IDL. Перед owner-транзакцией в Mainnet он также проверяет канонический USDC mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
- Локальный форк Kamino в этой ветке загружает `yie1…` и требует явный `V2_BUILD_DIR`, чтобы случайно не взять старый Devnet-бинарник.
- Маршрут сейчас разрешает **один фиксированный** Kamino USDC kVault. Другие Kamino vaults, ONyc и автоматическая перекладка не входят в этот релиз.

## Сборка и стоимость

В WSL Ubuntu из исходников этой ветки: Rust unit-тесты `6/6`, `NO_DNA=1 anchor build` завершился успешно. Бинарник `yield_vault.so` — `489200` байт, SHA-256 `416f7fe873c16873b099e7a75a535f38f61173aeb731a6321cf98373a8489cef`. Сгенерированный IDL имеет адрес `yie1…`; он перенесён во фронтенд. TypeScript `tsc --noEmit` прошёл во временной WSL-копии. Эти проверки не подтверждают поведение в настоящем Mainnet.

Локальный `next build --webpack` со штатным `next.config.ts` тоже прошёл. При prerender публичный Mainnet RPC несколько раз ответил `429`, но Next завершил сборку. Сбой WASM в первой попытке вызвала неполная временная копия без `next.config.ts`, а не код ветки. Vercel Preview на коммите `6edc5ac` собрался успешно 2026-09-25; runtime-проверки и их ограничения описаны ниже.

Локальный `solana-test-validator` загрузил бинарник под `yie1…`; `client/src/v2SecuritySmoke.ts` прошёл с disposable ключами: `init_config`, права агента, создание и закрытие Safe, восстановление вывода и запрет общего CPI-пути к Kamino. Это локальная регрессия, не Mainnet-транзакция.

Историческая оценка для `--max-len 650000` давала `3.30287884 SOL` rent ProgramData. Фактический deploy выполнен с `--max-len 489200` по размеру бинарника: ProgramData `2.486014840 SOL`, Program account `0.000833120 SOL`. Для более крупного обновления потребуется платное расширение ProgramData до upgrade; сохранённая authority это допускает. Полное уменьшение баланса deployer за попытки и успешное завершение — `2.489830570 SOL`, включая rent и сетевые комиссии. Официальные правила: [Solana Deploying Programs](https://solana.com/docs/programs/deploying), [Production Readiness](https://solana.com/docs/tools/production-readiness).

## Обязательные шаги до открытия пользователям

1. Закрытый mainnet-preview сайта собран и проверен на Mainnet genesis, program ID `yie1…`, mint канонического USDC и работающий read-only Kamino withdraw plan (детали ниже). Существующий Production/Devnet URL не переключать неожиданно. Перед on-chain пробой отдельно проверить сеть, владельца, program ID и mint в интерфейсе и окне кошелька.
2. Новый Helius URL добавлен только в серверную Preview-переменную `V2_MAINNET_RPC_URL` типа `sensitive`; браузер использует same-origin proxy. [PR #15](https://github.com/ssadkov/yield-ai-os-sol/pull/15) удалил прежний ключ из кода, но отзыв старого Helius-ключа нужно проверить отдельно. В основном checkout `web/.env` всё ещё содержит старый `NEXT_PUBLIC_PROGRAM_ID=3Vtz…`; он не является настройкой этого Preview. До публичного запуска proxy нужны ограничения частоты запросов.
3. Для закрытого пилота пользователь согласовал deployer `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A` как первоначальные admin и treasury с fee `500 bps`; `init_config` выполнен с отдельного разрешения пользователя. Комиссия перечисляется в USDC ATA treasury; другие токены, полученные адресом deployer, программа не перемещает. Перед доступом внешних пользователей передать admin и upgrade authority в Squads и проверить полномочия на сети.
4. Deploy бинарника под `yie1…`, проверка ProgramData, upgrade authority и хэша, а также `init_config` завершены. Это ещё не подтверждает работу Mainnet Safe и не открывает путь для пользовательских депозитов.
5. В закрытом Mainnet-пилоте на собственные `$1–5` USDC: создать Safe, внести, войти в Kamino, дождаться фактического `invest`, полностью выйти из резерва и вывести USDC владельцу. Проверить балансы, principal, стоимость и отрицательный сценарий назначения. Положительную прибыль и фактический перевод `5%` fee в treasury проверить отдельно: на форке этот случай не был подтверждён end-to-end. До полного успешного цикла нельзя давать этот маршрут обычным пользователям.
6. Текущий лимит доли в Kamino вычисляется по свободному USDC отдельного вызова и может позволить суммарную долю выше цели. До публичного запуска довести лимит до расчёта по общей стоимости позиции.

## RPC для закрытого Preview

Первоначально пользователь предоставил Supanode HTTP и WebSocket, но Preview получил `401` от этого RPC (история проверки ниже). 2026-09-26 закрытый Preview ветки `codex/yield-ai-v2-mainnet` переключён на новый Helius Mainnet URL. Текущие переменные Vercel для этой ветки:

| Переменная | Значение |
|---|---|
| `V2_MAINNET_RPC_URL` | полный Helius Mainnet HTTPS URL с новым API key; серверная переменная типа `sensitive`, значение не записывать в Git |
| `SUPANODE_TOKEN` | отсутствует в этой Preview-ветке; production-переменная не менялась |
| `V2_MAINNET_RPC_PROXY_ENABLED` | `1` |
| `NEXT_PUBLIC_V2_RPC_PROXY` | `1` |
| `NEXT_PUBLIC_RPC_URL` | `https://api.mainnet-beta.solana.com` (публичный fallback без ключа; переопределить унаследованное значение) |
| `NEXT_PUBLIC_PROGRAM_ID` | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` |
| `NEXT_PUBLIC_USDC_MINT` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `NEXT_PUBLIC_V2_LAB_ENABLED` | `0` |

Браузер обращается к `/api/v2/mainnet-rpc` на своём origin; Helius URL и API key остаются в серверной переменной и не входят в `NEXT_PUBLIC_*` или пакет JS. `SUPANODE_TOKEN` код отправляет только на настроенный Supanode host; для Helius он должен отсутствовать. Proxy ограничен списком методов и размером запроса, но может расходовать квоту: Preview должен оставаться закрытым, а перед публичным запуском потребуется серверное ограничение частоты запросов. `NEXT_PUBLIC_RPC_URL` оставить без секрета; в Preview он не используется подключением Safe при `NEXT_PUBLIC_V2_RPC_PROXY=1`, но ещё нужен другим страницам приложения.

WebSocket пока не подключать: v2 подтверждает транзакции через `getSignatureStatuses` и `getBlockHeight` по HTTP. Ключ Helius нельзя помещать в клиентский WebSocket URL. После установки переменных проверить `getGenesisHash = 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, чтение Safe и получение Kamino-плана, не отправляя транзакций.

## Проверка защищённого Preview 2026-09-25

- Повторный деплой прежнего коммита `6edc5ac` после обновления branch-scoped переменных: Vercel `dpl_E1KQi3az8ySVmj3EpnFgECs5N47W`, статус `READY`. Это Preview ветки `codex/yield-ai-v2-mainnet`, не Production.
- Через Vercel API подтверждены область действия Preview и точное совпадение семи публичных параметров с таблицей выше. `SUPANODE_TOKEN` присутствует как `sensitive`; его значение не выводилось и Vercel API его не раскрывает.
- Vercel Authentication включена для deployment URL (`all_except_custom_domains`); внешний запрос получил редирект на SSO. По временной ссылке доступа страница `/v2/safe` открылась, `/api/v2/kamino?op=metrics` вернул корректные метрики.
- Read-only `getGenesisHash` через `/api/v2/mainnet-rpc` вернул HTTP `401`, JSON-RPC `-32003`. Тело ответа совпало с прямым ответом Supanode на заведомо неверный Bearer-токен. План Kamino withdraw через тот же RPC вернул `502`. Причина в отклонённом credential; проверить действительность токена и отсутствие префикса `Bearer `, затем заменить Preview `SUPANODE_TOKEN` и пересобрать Preview.
- Независимый публичный Mainnet RPC вернул `null` для аккаунта программы `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`. Программа на Mainnet всё ещё не развёрнута. On-chain транзакций в этой проверке не отправлялось.
- Локальные `web/.env` и `agent/.env` содержат Helius Mainnet RPC URL: read-only `getGenesisHash` с обоих вернул Mainnet genesis. Значения ключей не выводились. Для Preview при переходе с Supanode использовать новый Helius key, поскольку прежний ранее был в коде; хранить полный URL только в серверной `V2_MAINNET_RPC_URL` и удалить веточную `SUPANODE_TOKEN`.

## Проверка защищённого Preview 2026-09-26

- Новый Helius URL взят из user-scoped `YIELD_AI_HELIUS_RPC_URL`; прямой read-only `getGenesisHash` подтвердил Mainnet. URL и ключ не выводились в лог и не добавлялись в Git.
- Только в Preview-ветке `V2_MAINNET_RPC_URL` пересоздана с типом `sensitive`; `SUPANODE_TOKEN` этой ветки удалён. Production-переменные не менялись. Vercel deployment `dpl_G5i6sFiS8SZJp47YqBCveCbFiuMa` на коммите `adcb87f` получил `READY`; target — Preview.
- В закрытом Preview `/v2/safe` вернул HTTP 200, `/api/v2/mainnet-rpc` подтвердил Mainnet genesis, `getAccountInfo(yie1…)` вернул `null`, Kamino metrics и read-only withdraw plan успешно ответили. Это проверка доступности RPC и построения плана, а не исполнения вывода или контракта.
- Программа `yie1…` остаётся неразвёрнутой в Mainnet. Никаких on-chain транзакций и операций со средствами эта проверка не выполняла.
- Дополнительный read-only preflight: vanity keypair в Ubuntu WSL выводит `yie1…`; исходник `lib.rs`, `Anchor.toml` и `Cargo.toml` WSL-копии совпадают с текущей веткой. Повторный `NO_DNA=1 anchor build` завершился успешно и дал прежний SHA-256 `416f7fe873c16873b099e7a75a535f38f61173aeb731a6321cf98373a8489cef` для `489200`-байтного `.so`.
- На момент этой проверки Mainnet deployer `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A` имел `5.169212938 SOL`; read-only `getMinimumBalanceForRentExemption(489245)` вернул `2.48601484 SOL` для ProgramData. Это оценка rent одной учётной записи, не итоговая цена deploy с буфером и комиссиями. Перед подписью нужно повторно проверить баланс и фактический план транзакций.

## Mainnet deploy программы 2026-09-26

- Пользователь отдельно подтвердил deploy только программы в Solana Mainnet: `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`, плательщик и начальная upgrade authority `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, бинарник `489200` байт с SHA-256 `416f7fe873c16873b099e7a75a535f38f61173aeb731a6321cf98373a8489cef`. `init_config`, USDC и Production не были частью этого разрешения.
- CLI в Ubuntu WSL использовал новый Helius Mainnet URL из user-scoped environment, `--max-len 489200`, `--use-rpc` и отдельный buffer keypair вне Git. Попытки записи останавливались на `Max retries exceeded`; продолжение того же buffer завершилось успешно. Buffer `4p8DYZPzZuWR31yj22Nu4RDqAQsYBGEUtgBZxKK93uPb` после deploy закрыт, его rent вернулся плательщику.
- Финальная подпись [`3rjmqMW8KQ1V5ergbvRdN78qmbwgw1z7rNNydeJmsZFkXdiRVDUPWwv7XANi6WRojTT4tQ1BYpXmraRSr6Nwbz34`](https://explorer.solana.com/tx/3rjmqMW8KQ1V5ergbvRdN78qmbwgw1z7rNNydeJmsZFkXdiRVDUPWwv7XANi6WRojTT4tQ1BYpXmraRSr6Nwbz34) — `finalized`, `err=null`, slot `450553234`, время `2026-09-26T03:25:59Z`. Program account исполняемый под `BPFLoaderUpgradeab1e11111111111111111111111`; ProgramData `GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY`, authority `8xwj…`, data length `489200`.
- Выгруженный из Mainnet байткод `489200` байт побайтно совпал с WSL-сборкой; SHA-256 обеих копий `416f7fe873c16873b099e7a75a535f38f61173aeb731a6321cf98373a8489cef`. Баланс deployer: `5.169212938 → 2.679382368 SOL`; фактическое уменьшение `2.489830570 SOL` включает неудавшиеся попытки записи и комиссии.
- На момент deploy этот результат подтверждал только развёртывание программы: `config`, реальный Mainnet Safe, Kamino-цикл и Production ещё не проверялись. До отдельного пилота нельзя направлять пользовательский USDC в Mainnet Safe.

## Mainnet init_config 2026-09-26

- Пользователь отдельно разрешил `init_config` в Solana Mainnet: config PDA `8MzeS2fxHGw35et7rQAqA4TJ8mw7p7CMP1rH1C5iRbk2`, admin, treasury и плательщик `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, performance fee `500 bps` (5%). Перед отправкой перепроверены Mainnet genesis, исполняемый program, ProgramData upgrade authority, отсутствие config и баланс плательщика.
- Симуляция подписанной транзакции завершилась с `err=null`, `InitConfig` success, `11711` CU. Подпись отправленной транзакции [`5Bt7tgANqSqwWNugWTycXasFbY9Aj83XrHWq3L9RuUsuH8DHNuVXmPTnQC2q1GmsfKpHbGzcaugGKjVMS5Zr8ouS`](https://explorer.solana.com/tx/5Bt7tgANqSqwWNugWTycXasFbY9Aj83XrHWq3L9RuUsuH8DHNuVXmPTnQC2q1GmsfKpHbGzcaugGKjVMS5Zr8ouS) получила `finalized`, `err=null`, slot `450559592`.
- On-chain чтение config на `finalized` подтвердило admin `8xwj…`, treasury `8xwj…`, `performance_fee_bps=500`, bump `253`. Баланс deployer: `2.679382368 → 2.678346128 SOL`; расходы `0.001036240 SOL` = rent config `0.001031240 SOL` + network fee `0.000005 SOL`. Mainnet Safe и USDC операции не выполнялись.

## Executor и подготовка пилота

В двух следующих пунктах описан **текущий on-chain бинарник**. Подготовленное изменение кода и интерфейса описано отдельно ниже.

- Контракт уже принимает один `agent: Pubkey` в owner-signed `initialize`; владелец может заменить или отозвать его через `set_agent`. Sponsored `create_safe_for` всегда создаёт Safe без агента. Опубликованный до whitelist UI передаёт `Pubkey::default()`, не предлагает назначение и не запускает автоматический executor.
- Агент может подписывать только типизированные `kamino_deposit` и `kamino_withdraw` в пределах заданной владельцем allocation. Обычный вывод средств и generic CPI требуют владельца. `allowed_programs` — список программ для owner-only CPI, не whitelist исполнителей. Глобального admin-managed whitelist executor-адресов в текущей развёрнутой версии нет.
- Read-only проверка 2026-09-26: USDC token account у treasury `8xwj…` отсутствует. `kamino_withdraw` требует `treasury_usdc_ata: Account<TokenAccount>` даже когда прибыль и fee равны нулю, поэтому перед Mainnet выходом его надо создать и проверить. Для agent-сценария также нужны funded signer, ненулевая allocation, Safe shares ATA, построение инструкций с `authority=agent` и успешный owner-signed/agent-signed пилот. Локальный форк проверял агентский путь с заранее созданным treasury ATA; он не заменяет Mainnet проверку.

## Executor whitelist: код готов, Mainnet активация ожидается

- Администратор из `Config` создаёт отдельный `ExecutorRegistry` PDA и задаёт до 16 публичных ключей плюс default из этого списка. Он может менять список и default без upgrade. Нулевой default ставит создание новых Safe через UI на паузу. Размер уже развёрнутого `Config` не меняется.
- Owner-signed `initialize` требует ненулевой адрес executor из текущего whitelist. Страница `/v2/safe` читает default из PDA и назначает его в той же транзакции создания Safe; пользователю не нужен выбор ключа или вторая подпись. Прямой вызов контракта с нулевым или чужим ключом отклоняется. Sponsored `create_safe_for` остаётся без executor: владелец не подписывает делегирование в этой операции.
- Только владелец может заменить executor на другой approved key или отключить его. Если админ изменил default, старые Safe не получают нового исполнителя молча: владелец нажимает «Update executor» и подписывает одну транзакцию. Удаление ключа из whitelist немедленно запрещает его agent-signed Kamino депозит/вывод даже в старых Safe. Владелец сохраняет право вывести средства и закрыть Safe. Agent по-прежнему не может выполнять generic CPI и прямой вывод. `allowed_programs` остаётся отдельным списком для owner-only CPI.
- Админская страница `/v2/admin/executors` позволяет создать и обновить список через кошелёк, чей адрес совпадает с `Config.admin`. Если текущий админский key `8xwj…` доступен только в WSL, для первой транзакции понадобится локальный подписанный скрипт или подключение этого кошелька к браузеру; приватный ключ в UI или Git не помещать. По выбору пользователя создан **новый отдельный executor key** в защищённом файле WSL (права `0600`), публичный адрес `3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH`. Он пока не включён в Mainnet whitelist и не запущен как сервис. Существующий agent key `B1XHm3F9c6fnSRtZaEkuVW2iEnBjLMqk3Dd3NqSUtUE4` не назначать по умолчанию.
- Локальная сборка обновлённой программы: `536904` байт, SHA-256 `37bcd17d1a92fe05665eed207e5a0167062c886dc3efa6df28cbbbb99a307042`. Security smoke на локальном validator прошёл: права admin, недействительные списки, нулевой/неодобренный key при создании, отзыв действующего executor, owner recovery. Локальный Kamino fork с agent-signed депозитом 60 тестовых USDC и полным выходом прошёл; потеря круга 0.001005 USDC. TypeScript и `next build --webpack` прошли. Mainnet транзакции для whitelist не отправлялись.
- ProgramData сейчас рассчитан на `489200` байт. Новый бинарник больше на `47704` байта, поэтому перед upgrade нужен `solana program extend`. Read-only Mainnet RPC 2026-09-26: space ProgramData `489245`, rent `2.486014840 SOL`; минимальный rent при space `536949` — `2.728351160 SOL`, прирост `0.242336320 SOL`. Баланс deployer `2.678346128 SOL`. После extension его баланс был бы около `2.436 SOL`, меньше предварительного rent upload buffer `2.728 SOL` без учёта комиссий: нужен дополнительный SOL и повторная проверка фактической схемы CLI перед подписью. Для Mainnet действий требуется отдельное согласование точных расходов, адресов и хэша.
- Порядок активации: read-only сверить ProgramData, upgrade authority, баланс и стоимость; расширить и обновить программу после отдельного разрешения; сверить байткод; админом инициализировать registry с `3ayNPp…` в approved и default; прочитать PDA; проверить закрытый Preview; затем проводить малый owner-signed цикл Mainnet USDC. До upgrade и registry init нельзя публиковать новый UI вместо действующего Preview: он намеренно блокирует Safe creation.

## Что пользователь может проверить сейчас

Devnet Safe уже создан, и пользователь может продолжать тестировать его **только тестовыми токенами в Devnet**, сверяя кластер в кошельке. Mainnet программа `yie1…` и config созданы, но Mainnet Safe `FuDC…` ещё нет; отправлять на предполагаемый Safe USDC заранее нельзя. Preview остаётся закрытым, Production не переключён. Пользовательские Mainnet депозиты не открывать до малого owner-signed пилота с полным выводом.
