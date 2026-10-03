# Yield AI v2 — первый Devnet цикл для Влада / Seeker

Дата: 2026-10-03. Ветка: `codex/yield-ai-v2-seeker-devnet`. Solana-native цикл: кошелёк → Safe → кошелёк. Kamino, EVM-подписи и мост в этот этап не входят.

## Что подключать

- [Публичный Devnet веб-стенд](https://yield-ai-solana-devnet.vercel.app/v2/devnet).
- **Devnet API base:** `https://yield-ai-solana-devnet.vercel.app/api/mobile/v1`.
- [Конфигурация API](https://yield-ai-solana-devnet.vercel.app/api/mobile/v1/config). В клиенте ожидаются `network.cluster = devnet` и `network.chain = solana:devnet`.
- Отдельный Vercel проект `yield-ai-solana-devnet`; Vercel login и password protection отключены с разрешения владельца. API не требует Vercel token от мобильного клиента. HTTP endpoint URL отдельно после deploy не запрашивался: READY, alias binding и protection проверены по API платформы; функциональные проверки и живые Devnet транзакции описаны ниже.
- [PR #28](https://github.com/ssadkov/yield-ai-os-sol/pull/28), base `codex/yield-ai-v2-cctp-mainnet`; в `main` эта версия ещё не слита. Исходники работающего Devnet deployment: `e00e9c280da6a640ac693f61d2cb11426b7fc5f2`.
- Прежний [защищённый Preview](https://yield-ai-os-sol-git-codex-yield-ai-v2-seeker-devnet-edbiz.vercel.app/v2/devnet) остаётся для разработки; мобильному приложению нужен публичный origin выше.
- Production `yield-ai-os-sol.vercel.app` для этого Devnet цикла не использовать. Изменений Production и Mainnet нет.

Схемы: [Solana Safe API](yield-ai-v2-solana-safe-api.md). Нативный Android HTTP-клиент не требует CORS. Стенд вызывает API с того же origin; cross-origin браузерный доступ отдельно не открыт.

### Короткое сообщение Владу

> Devnet готов для подключения: base URL `https://yield-ai-solana-devnet.vercel.app/api/mobile/v1`, без Vercel login. `GET /config`, `GET /safes`, `POST /safes/creation-plan`, `POST /deposits/plan`, `POST /withdrawals/plan`, `GET /transactions/{signature}`. Во всех запросах cluster `devnet`, owner type `solana`; суммы — строки USDC, не JS float. Optional `initialDepositUsdc` создаёт Safe и делает первый депозит за одну MWA-подпись. Для теста пополнить owner test SOL и Circle USDC на Solana Devnet. Kamino в этом этапе выключен; сначала новый Safe → депозит → partial/all вывод → timeout/restart recovery. API отдаёт unsigned v0, кошелёк подписывает, приложение отправляет в Devnet и сохраняет signature до send. Стенд `/v2/devnet` показывает тот же цикл в браузере; физический Seeker ещё требует твоей приёмки.

## Сеть

| Поле | Значение |
| --- | --- |
| cluster / wallet chain | `devnet` / `solana:devnet` |
| Genesis | `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` |
| Program | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5` |
| test-USDC mint | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| Executor registry | `AkP5jvAhA9vrtRLWhDjERD48k1J8MiE1Ad8dWPcASpYT` |
| Default executor | `3ayNPp7MoihfbnTQ4q6Ge5PVNe9tJsY5betKqKX7C8aH` |

Registry инициализирован и прочитан обратно. Создание назначает одобренного executor, включает лимиты 1000 USDC на действие / rolling 24h / principal; allocation `[0,0,0,0,0,0,0,0]`. Средства остаются в USDC. Worker здесь не включается.

## Первый запуск

1. Подключить Solana кошелёк через Mobile Wallet Adapter на Seeker, chain `solana:devnet`.
2. Получить test SOL на **этот же owner** через [Solana faucet](https://faucet.solana.com/). Для пробы достаточно 0,02 devnet SOL; API показывает точный rent/fee. Спонсорства пока нет.
3. Получить test USDC через [Circle faucet](https://faucet.circle.com/) — выбрать **Solana Devnet**, адрес owner. Mint должен совпадать с таблицей. API учитывает canonical owner ATA, не произвольные вторичные token accounts.
4. Прочитать `/config`, затем `/safes?ownerType=solana&address=OWNER&cluster=devnet`.
5. Новый owner: создать Safe вместе с первым депозитом за одну подпись. Для пустого Safe не передавать `initialDepositUsdc`.

```http
POST /api/mobile/v1/safes/creation-plan
Content-Type: application/json

{"cluster":"devnet","owner":{"type":"solana","address":"OWNER"},"initialDepositUsdc":"1"}
```

`ready` содержит один unsigned v0 `steps[0].transaction` (base64), `blockhash`, `lastValidBlockHeight`, `cost`, `simulation`, `initialDepositRaw`, `atomic: true`. Создание и перевод атомарны: если deposit не проходит, создание откатывается. Owner — sole signer и fee payer. Если Safe существует: `already_exists`, `steps: []`, без повторного депозита. Для следующего пополнения использовать `/deposits/plan`.

6. Проверить cluster/genesis/program/mint, owner/fee payer, canonical Safe/ATAs, сумму и инструкции до передачи payload в MWA. Подписать и отправить через Devnet RPC. API не подписывает и не отправляет транзакции.
7. Отдельное пополнение: `POST /deposits/plan` с `{"cluster":"devnet","owner":{"type":"solana","address":"OWNER"},"amount":"1"}`.
8. Частичный вывод: `POST /withdrawals/plan`, те же owner/cluster, `amount: "0.4"`. Полный idle вывод: `amount: "all"`. Получатель — canonical ATA того же владельца. Вывод из Kamino этот endpoint не выполняет.

## Подтверждение и повторы

До send сохранить signed bytes, signature, owner, cluster, blockhash, lastValidBlockHeight и requested operation в durable local journal приложения. Идентичные signed bytes можно повторно отправить в пределах срока blockhash; новый перевод после timeout автоматически не создавать.

```http
GET /api/mobile/v1/transactions/SIGNATURE?cluster=devnet&lastValidBlockHeight=HEIGHT
```

Статусы: `pending`, `processed`, `confirmed`, `finalized`, `failed`, `unknown_or_expired`. Запрос ищет историю. `unknown_or_expired`: finalized block height прошёл срок, RPC не нашёл signature — это **не доказательство отсутствия перевода**. Проверить историю через надёжный RPC/receipt и состояние Safe до нового депозита. Стенд сохраняет pending signature до send и блокирует следующую операцию до проверки.

Экран idle вывода: `awaiting_signature → submitted → confirmed/finalized`, с `failed/unknown`. Ожидание 10–60 минут и серверные задания понадобятся для соответствующих асинхронных продуктов. Endpoint статуса — chain query, не durable server job или signed broadcaster. `Idempotency-Key` не реализован.

## Живой цикл

Оператор `8xwj…` создал новый Safe `HktjYtEM12sH7qTKMArYqjiJ95c3Sq8W6GTFV85gb7fS`. Все операции finalized; balances прочитаны обратно. [Публичные результаты и подписи](yield-ai-v2-seeker-devnet-result.json).

| Операция | Результат | rent + fee, devnet SOL |
| --- | --- | --- |
| Registry init | default executor одобрен | 0,003484800 |
| Create + deposit | одна подпись, Safe получил 1 USDC | 0,008600360 |
| Partial withdraw | owner получил 0,4 USDC | 0,000005000 |
| Full idle withdraw | owner получил оставшиеся 0,6 USDC | 0,000005000 |

Всего 0,012095160 devnet SOL: network fees 0,000020000, остальное rent открытых аккаунтов. Safe остаётся открытым; возврата rent endpoint не делает. Wallet USDC до и после = 18; Safe после = 0. Стоимость зависит от наличия аккаунтов и актуального rent, не hard-coded для клиента.

20 unit/security tests, TypeScript и production build прошли. Локальная HTTP-проверка нашла все 4 finalized receipts, подготовила unsigned депозит без отправки, проверила повтор создания, пустой вывод и отказы wrong-cluster / recipient override / invalid signature. Live round trip проверяет программу и payload API, но пока **не доказывает MWA-подпись на физическом Seeker**: Влад проверяет её до включения Kamino.

## Дальше

1. Публичный Devnet API origin открыт: передать Владу ссылки и выполнить первый запрос `/config` с устройства.
2. Приёмка Seeker: новый owner, одна подпись create+deposit, отдельное пополнение, partial/all withdraw, timeout/restart recovery, wrong-chain, insufficient SOL/USDC.
3. Затем Kamino Mainnet и настройка executor; отдельно согласовать Mainnet операции.
4. Спонсорство SOL, signed submission/jobs, стратегии/APR, история и agent `why` — следующие API части.

## Оператор и deployment

`web/scripts/seeker-devnet-cycle.mjs`: однократный разрешённый Devnet pilot, защищённый прежний WSL signer, explicit ACK, cap 0,03 devnet SOL, signed simulation, fsync journal **до** send, receipt/balance verification. После записи подписанной операции повторный запуск запрещён. Публичный JSON без ключей и signed wire; приватный journal остаётся в WSL вне Git.

Preview env: `V2_MOBILE_CLUSTER=devnet`, `V2_DEVNET_RPC_URL` (server-only), `NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com`, `NEXT_PUBLIC_V2_RPC_PROXY=0`. Не менять `NEXT_PUBLIC_V2_PROGRAM_ID` на Devnet: другие старые страницы связаны с bundled Mainnet IDL; mobile API и `/v2/devnet` выбирают свой Devnet program явно. Relayer/agent keys в отдельный Devnet API deployment не добавлять.

Публичный проект: `prj_kV2DpRoR4aTyOsRgKZJr5QYKHMLo`, deployment `dpl_JVtobXcYiq7wx4jvHXzqKPWHewWJ`, target **staging** (Preview env), READY. Постоянный alias `yield-ai-solana-devnet.vercel.app` явно назначен этому deployment; назначение alias не меняет его target на Production. В новом проекте нет Git link: следующие push не обновляют этот стенд автоматически. Для будущего релиза явно указать `target: staging`, проверить READY и заново назначить этот alias. При создании первого deployment без target Vercel автоматически выбрал Production; эта попытка `dpl_46jJ68nwgoEkgXMrWJK7Vtah7Wzj` отменена до публикации.

В отдельном проекте также установлены `V2_MAINNET_RPC_PROXY_ENABLED=0`, `NEXT_PUBLIC_V2_LAB_ENABLED=0`, `V2_EVM_RELAYER_ENABLED=false`, `NEXT_PUBLIC_V2_CCTP_ENABLED=0`, `NEXT_PUBLIC_V2_CCTP_MAINNET_ENABLED=0`, `NEXT_PUBLIC_V2_CCTP_MAINNET_SEND_ENABLED=0`. Серверный RPC для пилота — public `https://api.devnet.solana.com`; signer/agent/relayer keys и Vercel token не добавлялись в deployment env. Весь runtime API выбирает Devnet независимо от wallet UI.
