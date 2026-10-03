# Yield AI v2 — первый Devnet цикл для Влада / Seeker

Дата: 2026-10-03. Ветка: `codex/yield-ai-v2-seeker-devnet`. Solana-native цикл: кошелёк → Safe → кошелёк. Kamino, EVM-подписи и мост в этот этап не входят.

## Что подключать

- Веб-стенд: `/v2/devnet` на Preview этой ветки.
- API: тот же origin + `/api/mobile/v1`.
- Public Devnet origin будет указан после настройки доступа Vercel. Текущий токен не имеет права создавать отдельные проекты; защищённый Preview требует Vercel login и **не подходит как публичный хост мобильного приложения**.
- Production `yield-ai-os-sol.vercel.app` для этого Devnet цикла не использовать. Изменений Production и Mainnet нет.

Схемы: [Solana Safe API](yield-ai-v2-solana-safe-api.md). Нативный Android HTTP-клиент не требует CORS. Стенд вызывает API с того же origin; cross-origin браузерный доступ отдельно не открыт.

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

1. Открыть отдельный публичный Devnet API origin без Vercel login и передать Владу.
2. Приёмка Seeker: новый owner, одна подпись create+deposit, отдельное пополнение, partial/all withdraw, timeout/restart recovery, wrong-chain, insufficient SOL/USDC.
3. Затем Kamino Mainnet и настройка executor; отдельно согласовать Mainnet операции.
4. Спонсорство SOL, signed submission/jobs, стратегии/APR, история и agent `why` — следующие API части.

## Оператор и deployment

`web/scripts/seeker-devnet-cycle.mjs`: однократный разрешённый Devnet pilot, защищённый прежний WSL signer, explicit ACK, cap 0,03 devnet SOL, signed simulation, fsync journal **до** send, receipt/balance verification. После записи подписанной операции повторный запуск запрещён. Публичный JSON без ключей и signed wire; приватный journal остаётся в WSL вне Git.

Preview env: `V2_MOBILE_CLUSTER=devnet`, `V2_DEVNET_RPC_URL` (server-only), `NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com`, `NEXT_PUBLIC_V2_RPC_PROXY=0`. Не менять `NEXT_PUBLIC_V2_PROGRAM_ID` на Devnet: другие старые страницы связаны с bundled Mainnet IDL; mobile API и `/v2/devnet` выбирают свой Devnet program явно. Relayer/agent keys в отдельный Devnet API deployment не добавлять.
