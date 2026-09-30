# Exponent ONyc Safe MVP

Один рынок: PT-ONyc 10JAN27, maturity `2027-01-10T13:00:00Z`. Без плеча. Работа выполнена в ветке `codex/exponent-fixed-income`, от `e83852b9857bf6e4c3c1a30ba19e3ae93d67a604` (существующие executor limits). Основной checkout не изменён. Mainnet отправка, публикация API и upgrade не выполнялись.

## Маршрут и единицы

- Вход: USDC Safe → прямой Orca ONyc/USDC → ONyc Safe → Exponent CLMM → PT Safe.
- Досрочная продажа: PT Safe → Exponent CLMM → ONyc Safe → тот же Orca → USDC **владельцу**.
- Погашение: PT-only Exponent Core merge → ONyc Safe → Orca → USDC **владельцу**. YT не требуется после maturity.

Каждая операция атомарна. Подготовка ATA/Position отдельная, с подписью владельца. PT имеет индексированный USD-номинал (9 decimals); фактическая выдача — ONyc. `1 PT != 1 ONyc`.

Особенность подтверждена исполнением настоящего Generic Scope ELF: аргумент wrapper `baseAmount` для покупки — **NAV-indexed nominal**, а не raw ONyc, несмотря на описание SDK `baseIn`. Safe вычисляет `ceil(actual_ONyc * Scope_NAV)` и сам формирует CPI. Простая передача raw ONyc оставляет существенный остаток ONyc. SY/ONyc токены при этом конвертируются 1:1; CLMM quote получает SY raw. На каждом действии допускается только до 32 raw SY округления (0.000000032 SY), прежние остатки не расходуются. Owner recovery доступен для этих остатков.

После maturity используется `Core.finalSyExchangeRate`, если она уже зафиксирована. До фиксации берётся текущий индекс с учётом Core all-time-high. Текущий NAV не подменяет frozen rate. Это проверено частичным погашением, затем синтетическим увеличением Scope NAV на 10% и погашением остатка. Oracle freshness проверяется отдельно от ставки погашения.

## NAV, себестоимость и комиссия

Отдельная Position PDA: `[exponent_position, Safe, CoreVault]`, 288 bytes вместе с discriminator. Существующий Vault layout и Kamino ABI сохранены.

Позиция хранит количество приобретённых PT, оставшуюся USDC-себестоимость, cumulative spent/received/realized/recovered basis, комиссии, последний NAV и Core rate, slot/time покупки. NAV — precise `[u64;4]`, scale `1e12`. Каждая покупка публикует `ExponentEntry` со своим снимком. Текущий NAV читается из проверенного Scope feed, index 108, max age 600s; SDK 0.9.29 для Scope возвращает cached SY index, поэтому API читает свежий feed напрямую.

Исторический NAV покупки сохраняем. Один текущий oracle account не восстанавливает историю покупок. Для текущей прибыли достаточно USDC basis и фактического выхода; для истории отдельных входов используются события/архив транзакций. Частичный выход списывает пропорциональную USDC basis целочисленно, последний выход списывает весь остаток без потери единицы округления. Прямые donations не становятся приобретёнными PT.

**Пилотная комиссия Yield AI = 0**, независимо от Kamino Config. В API отдельно показана будущая политика: `5% * max(USDC proceeds - USDC basis, 0)`. Это 5% прибыли, не пять процентных пунктов APY. `maturityPreview` показывает future net APY/USDC после предполагаемой комиссии и текущих DEX costs. На actual settlement комиссия пока не взимается.

## Контракт и executor

Инструкции: `init_exponent_position`, `set_exponent_policy`, `exponent_buy_pt`, `exponent_sell_pt`, `exponent_redeem_pt`, `recover_exponent`.

Executor требует существующую registry approval и назначение на Safe, enabled limits/position, положительную ONyc allocation. Проверяются action cap, rolling 24h volume, total principal и owner allocation. Exit volume учитывается как `max(received USDC, released basis)`, чтобы убыток не уменьшал расход бюджета. Owner устанавливает эти параметры существующими V2-инструкциями; `setup` не меняет allocation или Kamino policy.

Default economic loss limit: 500 bps **от USDC acquisition basis**, включая оба swap leg. Slippage default 50 bps, максимум 100 bps; это отдельный предел отклонения от котировки. Deadline максимум 120s, API выдаёт до 90s и не позже окончания oracle freshness. Owner может подписать экономический выход вне executor policy. Программы, рынок, mints, escrows, Scope policy, получатели и CPI layouts закреплены. Generic CPI/withdraw не обходят учёт защищённых ONyc/PT/SY/YT; owner имеет отдельный recovery в натуре с учётом basis и pause позиции.

## API

Все amount/minimumOutput — **строки raw integer**. USDC 6 decimals, ONyc/PT 9. `/api/v1` не менялся. Ответы `no-store`, Node runtime, без подписи/отправки и без секретов RPC.

| Endpoint | Назначение |
| --- | --- |
| `GET /api/v2/exponent/markets` | Один reviewed рынок, fresh NAV, decimals, maturity, ограничения |
| `GET /api/v2/exponent/quote` | `action=buy/sell/redeem`, raw amount, optional owner/authority/slippageBps |
| `POST /api/v2/exponent/transactions` | `action=setup/buy/sell/redeem`, owner, unsigned v0 message + simulation |

```bash
curl 'http://localhost:3000/api/v2/exponent/quote?action=buy&amount=1000000000&slippageBps=50'
curl 'http://localhost:3000/api/v2/exponent/quote?action=redeem&amount=1000000000000'
curl -X POST 'http://localhost:3000/api/v2/exponent/transactions' \
  -H 'Content-Type: application/json' \
  -d '{"action":"setup","owner":"OWNER_PUBKEY","maxLossBps":500,"slippageBps":50}'
curl -X POST 'http://localhost:3000/api/v2/exponent/transactions' \
  -H 'Content-Type: application/json' \
  -d '{"action":"buy","owner":"OWNER_PUBKEY","authority":"EXECUTOR_PUBKEY","amount":"1000000000","slippageBps":50}'
```

Для sell/redeem `amount` — tracked PT raw, owner позволяет API вернуть basis/loss floor. `authority` по умолчанию owner. Buy pilot limit: 10,000 USDC; PT raw limit 20,000 * 1e9, ниже небезопасного диапазона upstream double math. Расчёты settlement остаются u64/u128. Redeem quote до maturity только forecast; unsigned redeem до maturity отклоняется.

Builder заново получает котировку. Передайте `minimumOutput` из принятой котировки и `quotedAt` = её `chainTime`, чтобы не принять ухудшившуюся/старую котировку. Fingerprint `quoteId` — диагностический, не подпись и не разрешение. Подпись требуется единственному `authority`, а в setup — owner. Ответ содержит base64 transaction, blockhash/lastValidBlockHeight, serializedBytes, networkFeeLamports, simulation logs/error/CU. Account rent и optional priority fee не включены в доходность.

400 — некорректный ввод. 422 — состояние/котировка/setup/policy недоступны; обновить read state и quote. Simulation error нельзя трактовать как готовность исполнения. **`executionReady:false` всегда**: deployed Safe пока не содержит эти новые инструкции. Автоматических sign/send/retry-send нет.

## Проверки и результаты

[Полный машинный fork report](./exponent-onyc-fork-report.json) содержит quote data, snapshots и SHA256 исполняемых ELF. Runtime LiteSVM 1.5.0, публичные Exponent Core/CLMM/Generic SY/Orca ELF, реальные market accounts, новый локальный Safe ELF. Ключи владельца/executor и USDC funding — искусственные локальные fixtures. Bankrun 0.4.0 не исполняет текущий CLMM ELF; для воспроизведения используется LiteSVM.

Snapshot: `2026-09-30T19:40:45.876Z`, slot `452061427`, Scope NAV `1.150884088`. Partial sale 50%, затем весь остаток:

| Вход USDC | PT в Safe | Немедленный выход USDC владельцу |
| ---: | ---: | ---: |
| 100 | 103.326984386 | 99.868658 |
| 1,000 | 1,033.266156607 | 998.686590 |
| 10,000 | 10,332.292812357 | 9,986.866212 |

Дополнительная покупка на 1,000 USDC, локальный Clock `2027-01-10T13:01:00Z`, два частичных PT-only погашения: итог около 1,032.61 USDC владельцу. Первая часть при исходном NAV, вторая после искусственного +10% oracle NAV при **неизменной DEX liquidity**. Это проверка frozen rate/маршрута, не январская котировка. Все атомарные маршруты помещаются в 1,014 bytes с reviewed ALTs, потребляют меньше 500k CU в этих fixtures. Баланс SY содержит только ограниченное округление; PT и USDC basis обнуляются.

Пройдены 13 Rust tests, 5 TS tests, SBF/IDL сборка, client/web typecheck и Next production build. Все прежние instruction/account type layouts сравнены с новым IDL и совпадают. Fork проверяет rollback при action/24h/principal cap, pause, foreign signer, expired quote, widened slippage, market/recipient substitution и недостижимом minimum после Orca swap. HTTP smoke: markets 200, buy/sell quotes 200, malformed transaction request 400. Public RPC может отвечать 429; production нужен существующий настроенный provider.

Отдельный fresh HTTP read `2026-09-30` (~21:23 UTC): 1,000 USDC → 868.754569720 ONyc → 1,032.631853130 PT; обратная независимая котировка → 867.783949805 ONyc → 998.679404 USDC. Она отличается от fork snapshot и не является исполненным round trip.

Воспроизведение (Linux, Node >=22, `npm ci` в client и web; Solana/Anchor toolchain):

```bash
NO_DNA=1 anchor build
cargo test --lib
cd client
npm run exponent:test
# Новый пустой каталог, только публичные данные; fetch ELF при каждом запуске.
EXPONENT_FORK_DIR=/tmp/onyc-fixture npm run exponent:fork-prepare
cp ../target/deploy/yield_vault.so /tmp/onyc-fixture/
EXPONENT_FORK_DIR=/tmp/onyc-fixture EXPONENT_IDL="$PWD/../target/idl/yield_vault.json" npm run exponent:fork
```

Build toolchain в этой проверке: Anchor CLI 0.32.1, Rust Anchor deps 0.32.2, Solana CLI 3.1.12. SDK pins: Exponent 0.9.29, Whirlpool SDK 0.20.0. Существующие npm audit findings автоматически не исправлялись; полноценный dependency/security review остаётся release gate.

## Перед mainnet

Отдельное согласование upgrade и любых mainnet-транзакций. Затем повторить live hashes/upgrade authority/ProgramData/funding, проверить свежий Scope ABI/рынок/DEX/ALTs, owner configuration и небольшой owner-signed полный цикл. Fork не подтверждает январскую ликвидность, будущий NAV, отсутствие freeze ONyc или возможность primary OnRe redemption. По рынку допустимы потери/недоступность исполнения; 5% — предел executor, не гарантия выхода. In-kind recovery не зависит от работоспособности рынка/oracle.

Первичные источники: [Exponent post maturity](https://docs.exponent.finance/developers/learn/post-maturity), [buy wrapper](https://docs.exponent.finance/developer-clmm/typescript/instructions/ix-wrapper-buy-pt), [Core merge](https://docs.exponent.finance/developer-core/typescript/instructions/ix-merge-to-base), [Scope OraclePrices layout](https://github.com/Kamino-Finance/scope/blob/master/programs/scope/src/states/oracle_prices.rs), [Scope DatedPrice layout](https://github.com/Kamino-Finance/scope/blob/master/programs/scope/src/states/dated_price.rs). При расхождении краткого описания wrapper с raw units выше основанием служит сохранённый ELF/fork execution.
