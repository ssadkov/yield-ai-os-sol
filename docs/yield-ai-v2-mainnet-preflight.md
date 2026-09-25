# Yield AI v2 — подготовка Mainnet (`yie1…`)

Срез на 2026-09-25. Эта ветка готовит отдельный mainnet-релиз; **программа ещё не развёрнута, транзакции в Mainnet не отправлялись**. Рабочая ветка `codex/yield-ai-v2-mainnet` создана от `codex/yield-ai-v2` (`84f3aac`); основной checkout `C:\work\yield-ai-os-sol` не изменялся. Состояние ветки следует перепроверить перед выпуском.

## Адреса и текущая сеть

| Объект | Адрес / результат read-only проверки |
|---|---|
| Новый Mainnet program ID | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`; аккаунта в Mainnet пока нет |
| Vanity keypair | хранится только в WSL Ubuntu `~/.config/solana/yield-v2/vanity/`; `solana-keygen pubkey` совпал с `yie1…`; секрет в репозиторий и лог не копировать |
| Devnet program | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5`; остаётся отдельной программой |
| Владелец, подтвердивший Devnet Safe | `EP9fKzBpQzyZC2GYjjAF9tKEeUwi7dqNqMStmxdYu4h2` |
| Его Devnet Safe | `28z3NpLQPSA3AdAUeFrko3fRm3BtdZTNcCmYe7yUYVy3`, аккаунт принадлежит `8xa1…` |
| Будущий PDA Safe этого же владельца под `yie1…` | `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ`; пока это только расчёт, Safe не создан |
| Mainnet SOL владельца на момент проверки | `0.082353123 SOL`; показанные интерфейсом `13.9704 SOL` относились к Devnet |
| Mainnet deployer/первоначальная upgrade authority | `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`; баланс на момент проверки `5.169212938 SOL` |

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

Предлагаемая `--max-len 650000`: резерв роста `160800` байт. RPC вернул rent-exempt минимум `3.30287884 SOL` для `650045` байт ProgramData и `0.00083312 SOL` для аккаунта программы в `36` байт. Это **нижняя граница постоянного залога**, а не точная стоимость развёртывания: добавляются комиссии, временный buffer и возможные расходы при повторах. Баланс deployer необходимо проверить непосредственно перед отправкой; достаточность `5.169… SOL` пока не доказана. Официальные правила: [Solana Deploying Programs](https://solana.com/docs/programs/deploying), [Production Readiness](https://solana.com/docs/tools/production-readiness).

## Обязательные шаги до открытия пользователям

1. Завершить отдельный mainnet-preview сайта: его RPC должен иметь genesis Mainnet, program ID `yie1…`, mint канонического USDC. Не переключать существующий Devnet URL на Mainnet неожиданно. На текущем Vercel проекте переменные могут указывать на `8xa1…`; новая проверка IDL намеренно остановит такой билд/запуск. Проверить preview-сборку и serverless-функцию `/api/v2/kamino` с реальными настройками.
2. В основном checkout найден рабочий Mainnet Helius URL в `web/.env` и `agent/.env`: read-only `getGenesisHash` вернул `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`. `web/.env` при этом содержит старый `NEXT_PUBLIC_PROGRAM_ID=3Vtz…`. [PR #15](https://github.com/ssadkov/yield-ai-os-sol/pull/15) смёржен 2026-09-25; ротацию ранее раскрытого Helius-ключа нужно проверить отдельно. Сменить ключ и использовать новый URL только в серверной переменной, например `V2_MAINNET_RPC_URL`, не в `NEXT_PUBLIC_*` или клиентском пакете. Для клиентского RPC нужен отдельный публичный endpoint или серверный прокси с ограничениями; текущая локальная сборка прошла на публичном RPC, но получила `429`.
3. Для закрытого пилота пользователь согласовал deployer `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A` как первоначальные admin и treasury с fee `500 bps`. Это решение не разрешает само по себе deploy или `init_config`. Комиссия перечисляется в USDC ATA treasury; другие токены, полученные адресом deployer, программа не перемещает. Перед доступом внешних пользователей передать admin и upgrade authority в Squads и проверить полномочия на сети. `init_config` должен подписать действующий upgrade authority.
4. Только после отдельного согласования конкретных on-chain действий: развёрнуть бинарник под vanity ID `yie1…`, проверить ProgramData, upgrade authority и хэш; вызвать `init_config`, проверить treasury/fee. Параметры, суммы, плательщик и сеть должны быть сверены непосредственно перед подписью. Команда `solana program deploy` транслирует реальные платные транзакции; локальная сборка не является симуляцией deploy.
5. В закрытом Mainnet-пилоте на собственные `$1–5` USDC: создать Safe, внести, войти в Kamino, дождаться фактического `invest`, полностью выйти из резерва и вывести USDC владельцу. Проверить балансы, principal, стоимость и отрицательный сценарий назначения. Положительную прибыль и фактический перевод `5%` fee в treasury проверить отдельно: на форке этот случай не был подтверждён end-to-end. До полного успешного цикла нельзя давать этот маршрут обычным пользователям.
6. Текущий лимит доли в Kamino вычисляется по свободному USDC отдельного вызова и может позволить суммарную долю выше цели. До публичного запуска довести лимит до расчёта по общей стоимости позиции.

## Supanode для закрытого preview

Пользователь предоставил HTTP `https://fra.sol.supanode.xyz:8899` и WebSocket `wss://fra.sol.supanode.xyz:8900`. `SUPANODE_TOKEN` добавлен в Preview, но текущий credential отклоняется Supanode; результат проверки ниже. В Vercel **только для защищённого Preview** ветки `codex/yield-ai-v2-mainnet` (или локально в `web/.env.local`, без коммита) задать:

| Переменная | Значение |
|---|---|
| `V2_MAINNET_RPC_URL` | `https://fra.sol.supanode.xyz:8899` |
| `SUPANODE_TOKEN` | только значение токена, без префикса `Bearer `; секретная серверная переменная |
| `V2_MAINNET_RPC_PROXY_ENABLED` | `1` |
| `NEXT_PUBLIC_V2_RPC_PROXY` | `1` |
| `NEXT_PUBLIC_RPC_URL` | `https://api.mainnet-beta.solana.com` (публичный fallback без ключа; переопределить унаследованное значение) |
| `NEXT_PUBLIC_PROGRAM_ID` | `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` |
| `NEXT_PUBLIC_USDC_MINT` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| `NEXT_PUBLIC_V2_LAB_ENABLED` | `0` |

Код серверного `/api/v2/mainnet-rpc` и Kamino SDK добавляет `Authorization: Bearer <SUPANODE_TOKEN>` к HTTP запросам. Браузер обращается к этому proxy на своём origin; токен не входит в `NEXT_PUBLIC_*`, URL или пакет JS. Proxy ограничен списком методов и размером запроса, но может расходовать квоту: preview должен быть закрыт от посторонних, а перед публичным запуском потребуется серверное ограничение частоты запросов. `NEXT_PUBLIC_RPC_URL` оставить без секрета; в preview он не используется подключением Safe при `NEXT_PUBLIC_V2_RPC_PROXY=1`, но ещё нужен другим страницам приложения.

WebSocket пока не подключать: v2 подтверждает транзакции через `getSignatureStatuses` и `getBlockHeight` по HTTP. У `@solana/web3.js` нет заголовков в WebSocket handshake; перед публичным использованием WS нужен отдельный безопасный путь, а не токен в клиентском URL. См. [примеры RPC](https://supanode.xyz/docs/solana/rpc/examples) и [WebSocket](https://supanode.xyz/docs/solana/websocket/examples) Supanode. После установки переменных проверить `getGenesisHash = 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, чтение Safe и получение Kamino-плана, не отправляя транзакций.

## Проверка защищённого Preview 2026-09-25

- Повторный деплой прежнего коммита `6edc5ac` после обновления branch-scoped переменных: Vercel `dpl_E1KQi3az8ySVmj3EpnFgECs5N47W`, статус `READY`. Это Preview ветки `codex/yield-ai-v2-mainnet`, не Production.
- Через Vercel API подтверждены область действия Preview и точное совпадение семи публичных параметров с таблицей выше. `SUPANODE_TOKEN` присутствует как `sensitive`; его значение не выводилось и Vercel API его не раскрывает.
- Vercel Authentication включена для deployment URL (`all_except_custom_domains`); внешний запрос получил редирект на SSO. По временной ссылке доступа страница `/v2/safe` открылась, `/api/v2/kamino?op=metrics` вернул корректные метрики.
- Read-only `getGenesisHash` через `/api/v2/mainnet-rpc` вернул HTTP `401`, JSON-RPC `-32003`. Тело ответа совпало с прямым ответом Supanode на заведомо неверный Bearer-токен. План Kamino withdraw через тот же RPC вернул `502`. Причина в отклонённом credential; проверить действительность токена и отсутствие префикса `Bearer `, затем заменить Preview `SUPANODE_TOKEN` и пересобрать Preview.
- Независимый публичный Mainnet RPC вернул `null` для аккаунта программы `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`. Программа на Mainnet всё ещё не развёрнута. On-chain транзакций в этой проверке не отправлялось.
- Локальные `web/.env` и `agent/.env` содержат Helius Mainnet RPC URL: read-only `getGenesisHash` с обоих вернул Mainnet genesis. Значения ключей не выводились. Для Preview при переходе с Supanode использовать новый Helius key, поскольку прежний ранее был в коде; хранить полный URL только в серверной `V2_MAINNET_RPC_URL` и удалить веточную `SUPANODE_TOKEN`.

## Что пользователь может проверить сейчас

Devnet Safe уже создан, и пользователь может продолжать **только тестовыми токенами в Devnet**, сверяя кластер в кошельке. Это подтверждает доступ к Safe в Devnet, но не подтверждает Mainnet-деплой или вывод из Kamino. Mainnet Safe `FuDC…` ещё не создан; отправлять на него USDC заранее нельзя.
