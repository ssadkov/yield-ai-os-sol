# Safe: политика generic CPI и маршрут Orca

Дата: 2026-11-04. Ветка `claude/ecstatic-allen-hw0dme`. Это спецификация того, что уже написано в коде, и план выкатки.

**Статус на 2026-11-04:**
- Код в `programs/yield-vault/src/cpi_policy.rs`, `orca.rs` и `lib.rs`.
- `cargo test -p yield-vault --lib`: 31 тест проходит.
- **SBF-сборка** (`cargo build-sbf`, platform-tools v1.52, Agave 3.1.12) проходит без предупреждений о стеке. ELF — 1,027,352 байта, SHA-256 `f4bd23ff…` при закоммиченном `Cargo.lock`. IDL собирается `anchor idl build` (Anchor CLI 0.32.1).
- **Форк-тест** на LiteSVM с живыми ELF Orca и Token-2022 и снимком mainnet: 53 успешных шага и 45 ожидаемых отказов, все с нужной ошибкой (раздел 5).
- **Не сделано:** деплой и аудит. Без аудита на mainnet не выкатывать (порядок — в разделе 6).

Связанные документы:
- [hackathon-contract-review-2026-11.md](hackathon-contract-review-2026-11.md) — ревью, из которого выросли эти изменения;
- [exponent-onyc-mvp.md](exponent-onyc-mvp.md) — образец типизированного маршрута (Exponent).

## 1. Принципы

1. **Деньги идут только через типизированные инструкции.** В каждой зафиксированы программа, пул или рынок и формат вызова. Получатель — только ATA самого Safe. Минимум на выходе считает контракт. Действуют лимиты агента. Так уже устроены Kamino и Exponent, теперь так же устроен Orca.
2. **Generic CPI — аварийный люк владельца, а не маршрут.** Его границы описаны в разделе 2. Конечная цель — удалить его совсем.
3. **Расширение прав — медленно, сужение — сразу.** Новая программа в allowlist активируется через 48 часов. Удаление действует мгновенно.
4. **Котировка агента — не точка отсчёта.** Минимумы и ценовые полосы считаются по Pyth.
5. **Владелец всегда может выйти.** Вывод ликвидности Orca и вывод NFT позиции не требуют оракула и не зависят от агента.

## 2. Generic CPI (`execute_swap_cpi`, `execute_protocol_cpi`)

Общая логика в `cpi_policy::run_generic_cpi`. Вызывать по-прежнему может только владелец.

| Правило | Где в коде |
|---|---|
| Целью CPI не могут быть SPL Token, Token-2022, System, ATA, сам `yie1…`, BPF loader'ы и Loader v4 | `denied_program` |
| Программы с типизированным маршрутом (Kamino kVault, Exponent Core/CLMM/Generic SY, Orca) запрещены в любой позиции вызова | `dedicated_program` |
| Token-2022, `yie1…` и loader'ы запрещены и как обычные аккаунты. SPL Token, System и ATA передавать можно (они нужны свапам), но вызывать — нет | `passable_program` |
| Токен-аккаунты Safe в Token-2022 (NFT позиций Orca, xStocks) передавать нельзя вообще | `Token2022NotAllowed` |
| После CPI каждый переданный SPL-аккаунт Safe существует, принадлежит Safe, не имеет делегата, close authority не изменился | `snapshot_still_safe` |
| Kamino shares ATA и защищённые mint Exponent по-прежнему недоступны | `protect_generic`, `kamino_shares_ata` |

**Добавление программы в allowlist:**
1. `propose_allowed_program(program)` — владелец предлагает программу. Создаётся PDA `["cpi_policy", vault]`, в ней до 4 заявок.
2. Через `ALLOWLIST_DELAY_SECONDS` = 48 часов: `activate_allowed_program(program)` — отдельная, вторая подпись владельца.
3. `cancel_allowed_program(program)` — отмена заявки в любой момент.

Для запрещённых программ и программ с типизированным маршрутом заявку подать нельзя. При активации проверка повторяется.

**`set_allowed_programs`** теперь только удаляет: новый список должен быть подмножеством текущего. **`initialize`** и **`initialize_with_limits`** принимают только пустой allowlist.

**Что это закрывает.** Атаку из ревью (HIGH-1): одной подписью добавить SPL Token в allowlist и вызвать `SetAuthority` / `Approve` / `Transfer` для аккаунтов Safe. Теперь это невозможно ни одной подписью, ни двумя.

**Что остаётся.** Через активированную программу (например, Jupiter) владелец может отправить результат свапа на чужой аккаунт. От подменённого фронтенда защищают только 48 часов: UI обязан показывать заявки в ожидании, а владелец может их отменить. Полное решение — убрать generic CPI, когда для всех нужных действий появятся типизированные маршруты.

**Миграция не нужна.** У всех пяти Safe на mainnet allowlist пустой (проверено 2026-11-03). Старые клиенты, которые добавляют программы через `set_allowed_programs`, получат `UseTimelock`. Старый список `DEFAULT_ALLOWED_PROGRAMS` в `web/src/lib/vault.ts` уже и так не работал (18 записей при лимите 16); он и все вызовы `setAllowedPrograms` удаляются в [ssadkov/yield-ai-os-sol#41](https://github.com/ssadkov/yield-ai-os-sol/pull/41).

## 3. Маршрут Orca

### Пулы и активы (константы в `orca.rs`, сверены с mainnet 2026-11-04)

| # | Пул | Адрес | Tick spacing | Комиссия пула | Vault A / B |
|---|---|---|---:|---:|---|
| 0 | cbBTC/USDC | `HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM` | 4 | 0.04% | `FWiLr7…`, `5ahiXj…` |
| 1 | cbBTC/WBTC | `4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72` | 1 | 0.01% | `Br2L7L…`, `4WBthD…` |

| Актив | Mint | Decimals | Цена из фида | Проверка привязки |
|---|---|---:|---|---|
| USDC | `EPjFWdd5…` | 6 | USDC/USD | — |
| cbBTC | `cbbtcf3a…` | 8 | BTC/USD | cbBTC/USD в пределах 1% от BTC/USD |
| WBTC (Wormhole) | `3NZ9JMVB…` | 8 | BTC/USD | WBTC/USD в пределах 1% от BTC/USD |

**Частота обновления фидов Pyth.** Замер на mainnet 2026-11-04: 30 минут, опрос каждые 4 с, 429 снимков.

| Фид (sponsored, shard 0) | Адрес | Интервал: медиана / максимум | Возраст p99 | Предел в контракте |
|---|---|---|---|---|
| BTC/USD | `4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo` | 13 с / 54 с | 47 с | 90 с (`PRICE_MAX_AGE_SECONDS`) |
| USDC/USD | `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX` | 54 с / 56 с | 57 с | 120 с |
| WBTC/USD | `9gNX5vguzarZZPjTnE1hWze3s6UsZ7dsU3UnAmKPnMHG` | 54 с / 56 с | 56 с | 600 с (только привязка) |
| cbBTC/USD | `7oqYpv5YbjJ2PEsNeVVB5ZEZ8ZE6ufkj8hAvAiaiftbe` | **270 с / 270 с** | 280 с | 600 с (только привязка) |

Фид cbBTC обновляется раз в ~4.5 минуты. С прежним пределом 120 с агент стоял бы больше половины времени, а поднимать предел до 300 с значило бы считать цену BTC по пятиминутному значению. Поэтому оба BTC-актива оцениваются по BTC/USD (обновляется каждые ~13 с). Собственные фиды обёрток проверяют только, что обёртка не отвязалась от BTC: отклонение больше 1% → `Depeg`. Для этой проверки старое значение допустимо.

- Адреса Orca oracle PDA и Pyth feed пересчитываются в тесте `pinned_constants_are_consistent`.
- Все три mint — классический SPL Token. Пулы с Token-2022 активами пока не поддерживаются.
- **Оракул.** Pyth `PriceUpdateV2` с полной верификацией. Владелец аккаунта — Pyth receiver `rec5EK…`, адрес и feed id сверяются. Цена отвергается, если доверительный интервал шире 1%. Стоимость считается в базовых единицах USDC через фид USDC/USD.
- **Аккаунты.** Каждая инструкция с оракулом принимает `feed_a`, `feed_b` (фиды цены, для cbBTC и WBTC — BTC/USD), `feed_usdc`, `peg_a`, `peg_b`. Для актива без проверки привязки (USDC) в `peg_*` передаётся его фид цены.
- **Полоса цены.** Цена пула (`sqrt_price²`) должна отличаться от цены по оракулу не больше чем на `max_oracle_deviation_bps`. Для пары cbBTC/WBTC оракульная цена — ровно 1 (оба по BTC/USD). Отвязка одной из обёрток ловится дважды: пул выходит из полосы, а проверка привязки даёт `Depeg`.

### Политика владельца: `set_orca_policy` (PDA `["orca_policy", vault]`)

| Поле | Граница в контракте | Рекомендация для старта |
|---|---|---|
| `agent_enabled` | — | `false`, пока не пройдены форк-тесты и малый mainnet-цикл |
| `pools_mask` | только существующие пулы | `0b01` (cbBTC/USDC) или `0b10` (cbBTC/WBTC) |
| `max_slippage_bps` | 1–300 | 50 |
| `max_oracle_deviation_bps` | 1–200 | 50 |
| `max_hold_usdc[asset]` | — | USDC игнорируется; cbBTC/WBTC — не выше доли BTC в плане |
| `max_lp_principal_usdc` | — | ≤ `max_principal_usdc` из лимитов агента |
| `min_width_ticks` / `max_width_ticks` | min > 0, max ≥ min | cbBTC/USDC: 200 / 4000 (около ±1% / ±20%); cbBTC/WBTC: 10 / 200 |
| `max_opens_24h` | ≤ 24 | 4 |

Счётчики `open_positions` (не больше 4 позиций на Safe) и окно открытий за 24 часа сменой политики не сбрасываются. Для агента также нужен `allocation_bps[ROUTE_ORCA_LP = 2] > 0` и одобрение в реестре executor'ов. `orca_swap` и `orca_lp_increase/decrease` требуют аккаунт `executor_limits` и от владельца (как Exponent): Safe, созданный через `create_safe_for`, сначала вызывает `set_executor_limits`.

### Инструкции

| Инструкция | Кто | Основные проверки |
|---|---|---|
| `orca_swap(pool, a_to_b, amount_in, min_out)` | владелец, агент | Пул из списка; ATA Safe с обеих сторон; полоса оракула. `min_out ≥ oracle_out × (1 − slippage)`. `sqrt_price_limit` = текущая цена ± (slippage + deviation). После CPI: потрачено ≤ `amount_in`, получено ≥ `min_out`. Агенту: пул в маске, лимит хранения актива, объём в USD |
| `orca_lp_open(pool, lower, upper)` | владелец, агент (агент платит ренту) | Позиция = PDA `["position", mint]`, NFT в Token-2022 ATA Safe. Создаётся запись `["orca_position", vault, mint]`, в неё фиксируется `fee_bps`. Агенту: пул в маске, allocation > 0, полоса, тики кратны spacing, ширина в границах политики, текущая цена внутри диапазона, лимит открытий за 24 часа |
| `orca_lp_increase(liquidity, max_a, max_b)` | владелец, агент | Источники — ATA Safe. **Полоса оракула для всех**, включая владельца. Себестоимость = стоимость внесённого по оракулу. Агенту: `max_lp_principal_usdc`, объём и общий principal в лимитах агента |
| `orca_lp_decrease(liquidity, min_a, min_b)` | владелец без оракула, агент с оракулом и полосой | Получатели — ATA Safe. Себестоимость уменьшается пропорционально ликвидности, последняя единица забирает остаток. Объём агента = max(полученное, себестоимость) |
| `orca_lp_collect()` | владелец, агент | `update_fees_and_rewards`, затем `collect_fees_v2` в ATA Safe. `fee_bps` от собранного уходит на ATA treasury по каждому mint |
| `orca_lp_close()` | владелец, агент | Ликвидность = 0, комиссии собраны (Orca проверяет сама). NFT сжигается. Рента позиции и записи возвращается тому, кто её платил (`funder`) |
| `orca_lp_exit_nft()` | только владелец | Перевод NFT владельцу в кошелёк. Зарегистрированную позицию можно вывести, только когда начисленные комиссии собраны (`CollectFirst`); она снимается с учёта. NFT, присланный в Safe извне (без записи), выводится сразу |

Защита NFT позиций: `deposit_spl` и `withdraw_spl` отклоняют mint позиций Orca. Признак — Token-2022 mint с `MintCloseAuthority` = PDA позиции; это проверено на живых mint 2026-11-04. Generic CPI не принимает Token-2022-аккаунты Safe и программу Orca.

### Комиссия Yield AI на LP

- Берётся **с собранных торговых комиссий**, а не с principal или прироста стоимости.
- **10% по умолчанию** (`DEFAULT_LP_FEE_BPS = 1000`), допустимо **0–20%** (`MAX_LP_FEE_BPS = 2000`).
- Ставка хранится в PDA `["lp_fee_config"]`. Создаёт её `init_lp_fee_config` (admin, ставка 10%), меняет `set_lp_fee` (admin).
- **Ставка фиксируется в каждой позиции при открытии**, поэтому admin не может задним числом поднять её для уже открытых позиций.
- Округление вниз, в пользу владельца. Комиссия в натуре — в cbBTC, USDC или WBTC — на `ATA(config.treasury, mint)`. Эти ATA treasury должны существовать до первого `collect` с ненулевой комиссией.
- Kamino по-прежнему использует свой `performance_fee_bps` в `Config`, Exponent — 0%. LP-комиссия от них не зависит.

### Учёт

- **Маршрут `ROUTE_ORCA_LP = 2`.** `route_principal[2]` — сумма себестоимости всех позиций в базовых единицах USDC по оракулу на момент внесения. Раскладка `Vault` не менялась.
- **`close_safe`** теперь отказывает, пока в любом маршруте есть себестоимость (`OpenRoutePrincipal`). Иначе после повторной инициализации комиссия Kamino взялась бы с principal.
- **Непостоянные потери (IL)** не считаются убытком, который блокирует действие. От манипуляций защищают полоса оракула и лимиты. Остановки по просадке пока нет (см. раздел 7).

### Что агент с украденным ключом может сделать на Orca

Вывести деньги из Safe — не может: все получатели — ATA Safe. Он может:
- торговать в пределах `slippage` + `deviation` от оракула;
- вносить и выводить ликвидность внутри полосы — за цикл это потеря порядка 2 × deviation плюс комиссия пула.

Всё это ограничено суточным объёмом, `max_hold_usdc`, `max_lp_principal_usdc` и числом открытий. Защита — `agent_enabled = false` у владельца или удаление ключа из реестра админом.

## 4. Прочие изменения в этой ветке

- **`refund_excess_lamports`** — теперь только владелец (MEDIUM-2 из ревью). Агентский путь пользовался только старый v1-код Jupiter Borrow.
- **Тестовые скрипты.** `client/src/v2SecuritySmoke.ts`, `v2KaminoFork.ts` и `v2ExponentFork.ts` переведены на новые правила: пустой allowlist при создании, timelock, deny-list, вывод владельца через `withdraw`.
- **Новый форк-тест:** `client/src/orcaForkPrepare.ts`, `client/src/v2OrcaFork.ts` и тестовая программа `client/fixtures/cpi-probe` (не деплоить).
- **`Cargo.lock` в репозитории.** Раньше он был в `.gitignore`, поэтому задеплоенный хэш нельзя было воспроизвести: сборка `main` даёт `da29a3c7…`, 693,072 байта, а не `48da204e…`.
- **`web/`:** удаление `DEFAULT_ALLOWED_PROGRAMS` и кнопок «Approve whitelist» — отдельный PR [ssadkov/yield-ai-os-sol#41](https://github.com/ssadkov/yield-ai-os-sol/pull/41).

## 5. Сборка и проверка у себя

Нужны: Rust 1.89, Agave 3.1.12 (platform-tools v1.52), Anchor CLI 0.32.1, Node ≥ 22, Linux или WSL. `Cargo.lock` теперь в репозитории: сборка должна дать тот же SHA-256 `f4bd23ffc8084c7ed3855e83c8b59a968e4d8987fa5b1e221c5079b8587a09b4`.

Сборка и unit-тесты:

```bash
cargo test -p yield-vault --lib
```

```bash
NO_DNA=1 anchor build
```

```bash
sha256sum target/deploy/yield_vault.so
```

Копировать IDL в веб — только после деплоя нового ELF: веб сверяет задеплоенный хэш с проверенным.

```bash
cp target/idl/yield_vault.json web/src/idl/yield_vault.json
```

Форк-тест Orca (только чтение mainnet, в сеть ничего не отправляется):

```bash
cd client && npm ci
```

```bash
npm run orca:probe-build
```

```bash
ORCA_FORK_DIR=/tmp/orca-fork npm run orca:fork-prepare
```

```bash
ORCA_FORK_DIR=/tmp/orca-fork npm run orca:fork
```

Ожидаемый результат: `53 successful steps, 45 expected rejections`. Отчёт пишется в `/tmp/orca-fork/orca-fork-report.json` (CU, размеры транзакций, комиссии, отказы).

### Результаты форк-теста 2026-11-04

Снимок mainnet на слоте 465220140, живые ELF Orca Whirlpool (`c422b22f…`) и Token-2022 (`15a2e615…`).

| Что проверено | Результат |
|---|---|
| `orca_swap` 20,000 USDC → cbBTC (владелец), 10,000 (агент), cbBTC → WBTC (агент) | Проходит; недобор к цене Pyth — 24 bps (комиссия пула 4 bps + проскальзывание) |
| `min_out` ниже минимума по Pyth; сдвиг цены пула на 1%; цена BTC старше 90 с; привязка cbBTC старше 600 с; cbBTC на 2% ниже BTC; WBTC на 3% выше BTC; доверительный интервал 2%; подмена фида, привязки, ATA, vault, пула, tick array | `Slippage`, `PriceOutOfBand`, `StaleOracle`, `Depeg`, `OracleConfidence`, `InvalidOracle`, `ConstraintTokenOwner`, `InvalidPoolState`, `UnknownPool`, `InvalidTickArray` |
| Агент: лимит хранения cbBTC, действие > 50,000 USDC, пул вне маски, `agent_enabled = false`, чужой ключ | `HoldLimit`, `ExecutorActionLimit`, `PoolDisabled`, `AgentDisabled`, `Unauthorized` |
| open → increase → объём трейдера → collect | 22,083 сатоши cbBTC и 17.34 USDC комиссий; на treasury ровно 10% (2,208 / 1,734,146 raw), остальное в Safe |
| `set_lp_fee(2000)` после открытия | Старая позиция платит 10%, новая записывает 20% |
| decrease 50% → decrease остатка с устаревшим оракулом (владелец) → close | Себестоимость уходит в 0; агенту с устаревшим оракулом — `StaleOracle`; close до collect — `ClosePositionNotEmpty` (Orca); рента — только funder (`InvalidReceiver`) |
| `orca_lp_exit_nft` | До collect — `CollectFirst`; после — NFT у владельца, запись закрыта, себестоимость снята |
| `withdraw_spl` / `deposit_spl` с NFT позиции | `UseDedicatedInstruction` |
| 4-е открытие агента за сутки; 5-я позиция; ширина ниже минимума; principal выше `max_lp_principal_usdc` | `RebalanceLimit`, `TooManyPositions`, `InvalidRange`, `ExecutorPositionLimit` |
| Generic CPI: propose SPL Token / Orca; добавление через `set_allowed_programs`; активация за 1 с до 48 ч | `ProgramDenied`, `UseDedicatedInstruction`, `UseTimelock`, `TimelockActive` |
| Тестовая программа `cpi-probe` после активации: `Approve`, `SetAuthority` на USDC ATA Safe; Token-2022-аккаунт Safe; Orca в аккаунтах | `SafeAccountChanged`, `SafeAccountChanged`, `Token2022NotAllowed`, `UseDedicatedInstruction` |
| **Остаточный риск:** та же активированная программа делает `Transfer` 1 USDC с Safe на чужой аккаунт | **Проходит.** Защищают только 48 часов и проверка заявок в UI (раздел 2) |
| `close_safe` при открытой себестоимости; `refund_excess_lamports` от агента | `OpenRoutePrincipal`, `Unauthorized` |

Вычислительные и размерные затраты:
- **CU:** swap ~76–90k, open ~92–107k, increase ~72–79k, decrease ~60–80k, collect ~69–79k, close ~47k.
- **Размер транзакций без ALT:** swap 834 байта, open 856, increase 980, collect 913.
- **Open и increase вместе — 1240 байт, больше лимита 1232.** Клиент должен отправлять их двумя транзакциями или использовать lookup table.

**Размер программы.** 1,027,352 байта против 697,200 доступных в текущем ProgramData. Нужен `solana program extend` примерно на 330,152 байта — это около **2.30 SOL** ренты (возвращается при закрытии программы). Основная прибавка — код проверки аккаунтов Anchor на каждую инструкцию (10–14 KB на структуру). Сократить можно, объединив инструкции LP в одну с диспетчером, но это хуже для аудита.

**Старый форк-тест Exponent** (`npm run exponent:fork`) на снимке 2026-11-04 падает на первой покупке с `Residual` (`exponent.rs:419`). Падает одинаково и с задеплоенным ELF `48da204e…`, так что это не регрессия этой ветки. Живая покупка при этом работает: план покупки через публичный mainnet API (`/protocols/exponent/deposits/plan`, источник `safe`, 0.1 и 0.5 USDC) проходит симуляцию, ~466k CU. Харнес Exponent нужно разобрать отдельно (вероятно, размер первой покупки $100 на текущем состоянии пула).

## 6. Порядок выкатки

Не раньше 2026-11-14: в неделю хакатона апгрейд программы не нужен.

1. Upgrade authority и admin `Config` переводятся на Squads. Treasury — отдельный кошелёк.
2. Форк-тест из раздела 5 проходит на свежем снимке. Внешний аудит — хотя бы `cpi_policy.rs` и `orca.rs`.
3. Upgrade: extend ProgramData примерно на 330 KB (~2.30 SOL), буфер, upgrade. После — сверка хэша, authority и ренты.
4. `init_lp_fee_config`. Создать ATA treasury для cbBTC и WBTC.
5. Малый цикл владельца ($5–20): swap → open → increase → collect → decrease → close, затем `exit_nft` на отдельной позиции.
6. Только после этого — `agent_enabled = true` для одного пилотного Safe с лимитами из раздела 3.

## 7. Что дальше

- Таймлок на повышение `performance_fee_bps` у Kamino (MEDIUM-3 из ревью).
- Остановка по просадке для агента: стоимость позиции по оракулу ниже `principal × (1 − max_drawdown)` → агенту разрешён только выход.
- `collect_reward_v2`, если на закреплённых пулах появятся награды. Сейчас эмиссии нулевые. Если награды появятся, `close` будет ждать их сбора, а `exit_nft` продолжит работать.
- Типизированный адаптер Jupiter для агента: mint из списка, получатель — ATA Safe, минимум по оракулу, снимок всех токен-аккаунтов Safe до и после.
- Удаление generic CPI, когда для всех нужных действий будут типизированные маршруты.
- Ротация маршрута Exponent до 2027-01-10 и минимальная фиксированная ставка (раздел 3 ревью).
