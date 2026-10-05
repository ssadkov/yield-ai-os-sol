# Exponent ONyc Safe MVP

Один рынок: PT-ONyc 10JAN27, maturity `2027-01-10T13:00:00Z`. Без плеча. Работа выполнена в ветке `codex/exponent-fixed-income`, от `e83852b9857bf6e4c3c1a30ba19e3ae93d67a604` (существующие executor limits). Основной checkout не изменён. Mainnet Safe upgrade выполнен 2026-10-01; owner-signed торговый цикл и публикация API/UI ещё не выполнены.

## Маршрут и единицы

- Вход: USDC Safe → прямой Orca ONyc/USDC → ONyc Safe → Exponent CLMM → PT Safe.
- Досрочная продажа: PT Safe → Exponent CLMM → ONyc Safe → тот же Orca → USDC **владельцу**.
- Погашение: PT-only Exponent Core merge → ONyc Safe → Orca → USDC **владельцу**. YT не требуется после maturity.
- ONyc-вариант: владелец может внести ONyc в Safe, держать его там и вывести обратно; ONyc Safe → Exponent CLMM → PT Safe, затем продажа или погашение → ONyc владельцу. Для этого варианта Orca не вызывается. Смешанный вход и выход (например ONyc → PT → USDC) использует только нужный обменный шаг.

Каждая операция атомарна. Подготовка ATA/Position отдельная, с подписью владельца. PT имеет индексированный USD-номинал (9 decimals); фактическая выдача — ONyc. `1 PT != 1 ONyc`.

Особенность подтверждена исполнением настоящего Generic Scope ELF: аргумент wrapper `baseAmount` для покупки — **NAV-indexed nominal**, а не raw ONyc, несмотря на описание SDK `baseIn`. Safe вычисляет `ceil(actual_ONyc * Scope_NAV)` и сам формирует CPI. Простая передача raw ONyc оставляет существенный остаток ONyc. SY/ONyc токены при этом конвертируются 1:1; CLMM quote получает SY raw. На каждом действии допускается только до 32 raw SY округления (0.000000032 SY), прежние остатки не расходуются. Owner recovery доступен для этих остатков.

После maturity используется `Core.finalSyExchangeRate`, если она уже зафиксирована. До фиксации берётся текущий индекс с учётом Core all-time-high. Текущий NAV не подменяет frozen rate. Это проверено частичным погашением, затем синтетическим увеличением Scope NAV на 10% и погашением остатка. Oracle freshness проверяется отдельно от ставки погашения.

## NAV, себестоимость и комиссия

Отдельная Position PDA: `[exponent_position, Safe, CoreVault]`, 288 bytes вместе с discriminator. Существующий Vault layout и Kamino ABI сохранены.

Позиция хранит количество приобретённых PT, оставшуюся USDC-себестоимость, cumulative spent/received/realized/recovered basis, комиссии, последний NAV и Core rate, slot/time покупки. NAV — precise `[u64;4]`, scale `1e12`. Каждая покупка публикует `ExponentEntry` со своим снимком. Текущий NAV читается из проверенного Scope feed, index 108, max age 600s; SDK 0.9.29 для Scope возвращает cached SY index, поэтому API читает свежий feed напрямую.

Исторический NAV покупки сохраняем. Один текущий oracle account не восстанавливает историю покупок. Для текущей прибыли достаточно USDC basis и фактического выхода; для истории отдельных входов используются события/архив транзакций. Частичный выход списывает пропорциональную USDC basis целочисленно, последний выход списывает весь остаток без потери единицы округления. Прямые donations не становятся приобретёнными PT.

**Пилотная комиссия Yield AI = 0**, независимо от Kamino Config. В API отдельно показана будущая политика: `5% * max(USDC proceeds - USDC basis, 0)`. Это 5% прибыли, не пять процентных пунктов APY. `maturityPreview` показывает future net APY/USDC после предполагаемой комиссии и текущих DEX costs. На actual settlement комиссия пока не взимается.

Для входа собственным ONyc в позиции записывается USDC-эквивалент по свежему Scope NAV на момент покупки PT. Это **оценка**, а не фактическая внешняя цена приобретения ONyc владельцем. Прямое хранение ONyc в Safe не получает дополнительной fee-базы. Выход в ONyc не является USDC-реализацией; комиссия остаётся нулевой. Перед включением 5% fee потребуется отдельно определить ONyc-выход и смешанные входы, без ретроактивного начисления на пилотные позиции.

## Контракт и executor

Инструкции: `init_exponent_position`, `set_exponent_policy`, `deposit_onyc`, `withdraw_onyc`, `exponent_buy_pt`, `exponent_buy_pt_with_onyc`, `exponent_sell_pt`, `exponent_sell_pt_for_onyc`, `exponent_redeem_pt`, `exponent_redeem_pt_for_onyc`, `recover_exponent`. ONyc-native действия на первом этапе подписывает только владелец; executor ограничен USDC-маршрутом.

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

`asset` по умолчанию `USDC`. `asset:"ONYC"` убирает Orca: для `buy` входная сумма — raw ONyc, для `sell`/`redeem` выход — ONyc владельцу. Эти операции требуют подпись владельца; `deposit_onyc` и `withdraw_onyc` через `/transactions` позволяют держать ONyc в Safe. Setup также создаёт owner ONyc ATA. Если Orca недоступна, ONyc-native котировка и выход не требуют загрузки пула. Для ONyc-входа API возвращает `maturityOnycAtCurrentNavRaw` как сценарий при сегодняшнем NAV, но не показывает будущий USDC APY без котировки конечного обмена; фактический ONyc выход зависит от frozen rate.

Примеры тел запросов: `/quote` — `{"action":"buy","asset":"ONYC","amount":"100000000000"}`; `/transactions` — `{"action":"deposit_onyc","owner":"OWNER_PUBKEY","amount":"100000000000"}`. Для `/transactions` покупки/продажи/погашения укажите `owner`, `action`, `asset`, raw `amount` и при необходимости `authority`, `minimumOutput`, `quotedAt`. Ответ содержит только неподписанную транзакцию; EVM Safe этой версией не поддерживается.

Builder заново получает котировку. Передайте `minimumOutput` из принятой котировки и `quotedAt` = её `chainTime`, чтобы не принять ухудшившуюся/старую котировку. Fingerprint `quoteId` — диагностический, не подпись и не разрешение. Подпись требуется единственному `authority`, а в setup — owner. Ответ содержит base64 transaction, blockhash/lastValidBlockHeight, serializedBytes, networkFeeLamports, simulation logs/error/CU. Account rent и priority fee не включены в доходность. Builder задаёт `SetComputeUnitPrice = 10 000` micro-lamports/CU при лимите 1 400 000 CU: максимум 14 000 lamports priority fee плюс базовая комиссия; фактическое значение отражено в `networkFeeLamports`. Кошелёк должен подписать ровно подготовленное сообщение — добавленные им инструкции отклоняются до отправки.

400 — некорректный ввод. 422 — состояние/котировка/setup/policy недоступны; обновить read state и quote. Simulation error нельзя трактовать как готовность исполнения. API выставляет `executionReady:true` только если прочитанный Mainnet ProgramData содержит **ровно проверенный ELF SHA-256** и конкретная транзакция успешно симулируется. После upgrade on-chain gate прошёл для котировки покупки и unsigned setup. API сам не подписывает и не отправляет транзакции. Для текущего Orca ONyc/USDC пула SDK может вернуть dynamic TickArray, который существующий Safe не принимает. Builder использует только проверенный fixed TickArray текущего диапазона и дублирует его в трёх слотах Orca; каждая конкретная транзакция должна пройти Mainnet-симуляцию и on-chain minimum output. Если цена выйдет за этот диапазон, signing остаётся выключенным до отдельного обновления контракта. Это ограничение пилотного маршрута, а не гарантия постоянной ликвидности.

UI `/v2/exponent` подключён к Phantom/Solflare через существующий Solana wallet adapter. Владелец подключает **тот адрес, которому принадлежит Safe**, создаёт position/ATA действием `Set up position`, а USDC заранее вносит через `/v2/safe`. Экран показывает свежую котировку, минимальный выход, NAV и basis; отдельная кнопка строит unsigned v0 transaction и показывает simulation/fee, следующая запрашивает подпись и отправляет её через wallet RPC. При смене действия/суммы/кошелька подготовленная транзакция инвалидируется; при неверном Mainnet genesis, истечении quote/blockhash, неожиданном signer/program или несовпадении ELF отправка блокируется. После отправки UI показывает signature и опрашивает confirmation; неопределённый статус нельзя автоматически повторять. ONyc можно отдельно внести, оставить в Safe и вывести. Погашение до maturity — только read-only preview.

UI-проверка: web TypeScript проходит, локальный `GET /v2/exponent` ответил 200 и отрендерил заголовок/кнопку котировки. Next production build с новым экраном скомпилировал код и закончил TypeScript, но полный static-page этап остановлен после многократных `429 Too Many Requests` от внешнего RPC для несвязанного `/api/earn-ideas`; перед публикацией повторить build с production provider и пройти browser smoke с Phantom без отправки транзакции до upgrade.
Локальный `npm run exponent:deployment-test` проверяет, что UI/API gate принимает именно собранный ELF и отвергает изменённый ELF, укороченный ProgramData, неверный указатель и ошибку RPC.

## Проверки и результаты

[Полный машинный fork report](./exponent-onyc-fork-report.json) содержит quote data, snapshots и SHA256 исполняемых ELF. Runtime LiteSVM 1.5.0, публичные Exponent Core/CLMM/Generic SY/Orca ELF, реальные market accounts, новый локальный Safe ELF. Ключи владельца/executor и USDC funding — искусственные локальные fixtures. Bankrun 0.4.0 не исполняет текущий CLMM ELF; для воспроизведения используется LiteSVM.

Snapshot: `2026-10-01T07:13:30.303Z`, slot `452216889`, Scope NAV `1.151213761`. Partial sale 50%, затем весь остаток:

| Вход USDC | PT в Safe | Немедленный выход USDC владельцу |
| ---: | ---: | ---: |
| 100 | 103.271094890 | 99.869184 |
| 1,000 | 1,032.708817771 | 998.691854 |
| 10,000 | 10,326.875037482 | 9,986.918664 |

ONyc-native цикл: owner внёс 150 ONyc, купил за 100 ONyc 118.881763702 PT, досрочно продал PT за 99.889162176 ONyc владельцу и вывел оставшиеся 50 ONyc. Далее куплены PT из 100 ONyc и 1,000 USDC. При локальном Clock `2027-01-10T13:01:00Z` половина PT погашена в 575.654092 USDC, остаток — в 500.163420840 ONyc владельцу. Перед вторым погашением oracle NAV искусственно поднят на 10% при **неизменной DEX liquidity**; frozen Core rate сохранился. Это проверка маршрутов, не январская котировка. ONyc-native buy/sell укладываются в 810/843 bytes, maturity USDC route — 1,014 bytes; операции потребляют меньше 500k CU в этих fixtures. PT и позиционная basis обнуляются.

Пройдены 13 Rust tests, SBF/IDL сборка без stack warnings, client/web typecheck, Next production compilation и local LiteSVM fork с реальными Exponent/Orca ELF. Предыдущие USDC-кейсы и 10 негативных сценариев сохранены; добавлены ONyc deposit/hold/withdraw, buy/sell/redeem, отказ executor для ONyc-native операции и два rollback/recipient теста. Локальный HTTP smoke через настроенный private Mainnet RPC получил 200 для UI и quote; unsigned setup успешно симулировался после upgrade. Полный Next static-page build ранее упёрся в 429 внешнего RPC на несвязанном `/api/earn-ideas`; перед публикацией его нужно повторить.

Свежие независимые read-only котировки 2026-10-01, slot `452219770`: 1,000 USDC → 1,032.714359682 PT; немедленная обратная продажа этого количества → 998.687414 USDC (расчётная потеря 0.1312586%). Прямой вход 100 ONyc → 118.881423660 PT; обратная продажа → 99.889126030 ONyc (0.11087397%). Это два последовательных расчёта по состоянию рынка, **не исполненный round trip**; сумма после maturity зависит от frozen rate и ликвидности выхода.

Воспроизведение (Linux, Node >=22, `npm ci` в client и web; Solana/Anchor toolchain):

```bash
NO_DNA=1 anchor build
cargo test --lib
cd client
npm run exponent:test
npm run exponent:live-check # Mainnet read-only, verifies genesis and fresh USDC/ONyc round-trip quotes
# Новый пустой каталог, только публичные данные; fetch ELF при каждом запуске.
EXPONENT_FORK_DIR=/tmp/onyc-fixture npm run exponent:fork-prepare
cp ../target/deploy/yield_vault.so /tmp/onyc-fixture/
EXPONENT_FORK_DIR=/tmp/onyc-fixture EXPONENT_IDL="$PWD/../target/idl/yield_vault.json" npm run exponent:fork
```

Build toolchain в этой проверке: Anchor CLI 0.32.1, Rust Anchor deps 0.32.2, Solana CLI 3.1.12. SDK pins: Exponent 0.9.29, Whirlpool SDK 0.20.0. Существующие npm audit findings автоматически не исправлялись; полноценный dependency/security review остаётся release gate.

Релизный ELF с `opt-level = "s"`: **686,960 bytes**, SHA-256 `9543eb14e69694d25d6a4d1bba2a5bcc7f00f1d34a095112d0b898764805269f`. Изолированная сборка и обычный `anchor build` дали один hash; полный LiteSVM Exponent fork и 12 отказных сценариев прошли. Ещё меньший `opt-level = "z"` оставлен экспериментом из-за SBF stack diagnostics. Mainnet upgrade: signature `3oJeThzj5H883ySUpEGUQfw5CMtFnt3iDNYbH5bjqbCFfMED5W4Tsa8W3toVGztnnBqwNTQEouKXHfqtWSwm6yvR`, deployed slot `452247057`; read-only dump on-chain ELF совпал по SHA-256 и длине с локальным. ProgramData `GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY`, rent `3.49063564 SOL`. Buffer `HdjbcJnhtsNd6y67azbtpw7ZtRZ46QaXYhkQWdMgPfey` закрыт, его rent вернулся; итоговый баланс authority при проверке `3.660720821 SOL`. Первый RPC upload исчерпал retries после расширения ProgramData, успешное продолжение из того же buffer выполнено через QUIC. Старый ELF для отката сохранён в `~/.local/share/yield-ai/rollback/yield-v2-before-onyc-20261001-7f0da515.so` в Ubuntu (SHA-256 `7f0da515e6a1d4249b5748457e279cc0636867cd43d973522da8e698ac80ebe9`).

## После mainnet upgrade

Для live-проверки владелец подключает именно свой Solana Safe, создаёт position/ATA, вносит небольшую сумму USDC и подписывает покупку и досрочную продажу в UI. Перед каждой подписью обновить котировку и проверить simulation, минимум выхода и адреса. **Реальное погашение PT-ONyc 10JAN27 в Mainnet невозможно проверить до 2027-01-10 13:00 UTC**; сейчас этот шаг доказан только локальным fork с перемоткой Clock. Не обозначать живой цикл как включающий maturity до фактической январской транзакции. Fork не подтверждает январскую ликвидность, будущий NAV, отсутствие freeze ONyc или возможность primary OnRe redemption. По рынку допустимы потери/недоступность исполнения; 5% — предел executor, не гарантия выхода. In-kind recovery не зависит от работоспособности рынка/oracle.

Первичные источники: [Exponent post maturity](https://docs.exponent.finance/developers/learn/post-maturity), [buy wrapper](https://docs.exponent.finance/developer-clmm/typescript/instructions/ix-wrapper-buy-pt), [Core merge](https://docs.exponent.finance/developer-core/typescript/instructions/ix-merge-to-base), [Scope OraclePrices layout](https://github.com/Kamino-Finance/scope/blob/master/programs/scope/src/states/oracle_prices.rs), [Scope DatedPrice layout](https://github.com/Kamino-Finance/scope/blob/master/programs/scope/src/states/dated_price.rs). При расхождении краткого описания wrapper с raw units выше основанием служит сохранённый ELF/fork execution.
