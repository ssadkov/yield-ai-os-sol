# Safe: политика generic CPI и маршрут Orca

Дата: 2026-11-04. Ветка `claude/ecstatic-allen-hw0dme`. Это спецификация того, что уже написано в коде, и план выкатки.

**Статус:**
- Код в `programs/yield-vault/src/cpi_policy.rs`, `orca.rs` и `lib.rs`.
- `cargo test -p yield-vault --lib`: 30 тестов проходят. `cargo check --features idl-build` проходит, IDL генерируется.
- **Не сделано:** SBF-сборка (`anchor build`), прогон на форке, деплой, аудит. Без форк-тестов и аудита на mainnet не выкатывать (порядок — в разделе 6).

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

**Миграция не нужна.** У всех пяти Safe на mainnet allowlist пустой (проверено 2026-11-03). Старые клиенты, которые добавляют программы через `set_allowed_programs`, получат `UseTimelock`. Старый список `DEFAULT_ALLOWED_PROGRAMS` в `web/src/lib/vault.ts` уже и так не работал (18 записей при лимите 16). Его и вызовы `setAllowedPrograms` в `DepositCard`, `AIChat`, `useRebalance`, `useVault` нужно удалить отдельным PR.

## 3. Маршрут Orca

### Пулы и активы (константы в `orca.rs`, сверены с mainnet 2026-11-04)

| # | Пул | Адрес | Tick spacing | Комиссия пула | Vault A / B |
|---|---|---|---:|---:|---|
| 0 | cbBTC/USDC | `HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM` | 4 | 0.04% | `FWiLr7…`, `5ahiXj…` |
| 1 | cbBTC/WBTC | `4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72` | 1 | 0.01% | `Br2L7L…`, `4WBthD…` |

| Актив | Mint | Decimals | Pyth feed (sponsored, shard 0) |
|---|---|---:|---|
| USDC | `EPjFWdd5…` | 6 | `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX` |
| cbBTC | `cbbtcf3a…` | 8 | `7oqYpv5YbjJ2PEsNeVVB5ZEZ8ZE6ufkj8hAvAiaiftbe` |
| WBTC (Wormhole) | `3NZ9JMVB…` | 8 | `9gNX5vguzarZZPjTnE1hWze3s6UsZ7dsU3UnAmKPnMHG` |

- Адреса Orca oracle PDA и Pyth feed пересчитываются в тесте `pinned_constants_are_consistent`.
- Все три mint — классический SPL Token. Пулы с Token-2022 активами пока не поддерживаются.
- **Оракул.** Pyth `PriceUpdateV2` с полной верификацией. Владелец аккаунта — Pyth receiver `rec5EK…`, feed id сверяется. Возраст цены — не больше 120 с: на 2026-11-04 фиды были свежими на 22–93 с, порог надо подстроить по реальной частоте обновлений. Цена отвергается, если доверительный интервал шире 1%. Стоимость считается в базовых единицах USDC через фид USDC/USD.
- **Полоса цены.** Цена пула (`sqrt_price²`) должна отличаться от цены по оракулу не больше чем на `max_oracle_deviation_bps`. Так одновременно ловятся манипуляция пулом и отвязка cbBTC или WBTC: для пары cbBTC/WBTC отношение двух фидов около 1, и при отвязке пул выходит из полосы.

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

## 5. Сборка и проверка у себя

```bash
cargo test -p yield-vault --lib
```

```bash
NO_DNA=1 anchor build
```

```bash
cp target/idl/yield_vault.json web/src/idl/yield_vault.json
```

На что смотреть:
1. **SBF stack warnings в `anchor build`.** Крупные аккаунты обёрнуты в `Box`, но `OrcaLiquidity` и `OrcaCollect` большие. Если будет предупреждение о стеке, вынести проверки в отдельные функции или разбить структуры.
2. **Размер ELF.** Свободного места в ProgramData — около 6 KB (697245 против 690944 байт). Новый код почти наверняка потребует `solana program extend` (минимум 10240 байт; прошлый extend на 10240 байт стоил 0.052 SOL ренты). Точное число станет известно после сборки.
3. **Локальный validator:** `npx tsx src/v2SecuritySmoke.ts` из `client/` — новые проверки timelock и deny-list.

Форк-тесты, которые нужно написать до деплоя (LiteSVM, по образцу `exponentForkPrepare.ts`, с ELF Orca, настоящими пулами и фидами Pyth):

| Сценарий | Ожидание |
|---|---|
| `orca_swap` USDC→cbBTC и обратно, owner и agent | Балансы сходятся; `min_out` ниже оракульного минимума → `Slippage` |
| Сдвинуть цену пула перед swap / increase / open агента | `PriceOutOfBand` |
| Подменить ATA Safe, vault пула, фид, пул, tick array, oracle PDA | Откат |
| Устаревший фид (warp clock > 120 с) | Агент: `StaleOracle`; owner decrease проходит |
| Open → increase → swap для накопления комиссий → collect | Комиссия 10% на ATA treasury, 90% в Safe |
| `set_lp_fee(2000)` после open | Открытая позиция платит по своей зафиксированной ставке |
| decrease 50% → decrease 100% → collect → close | Себестоимость 0, рента вернулась funder |
| `orca_lp_exit_nft` с несобранными комиссиями | `CollectFirst`; после collect NFT у владельца |
| `withdraw_spl` / `deposit_spl` с mint позиции | `UseDedicatedInstruction` |
| Агент: пул вне маски, `agent_enabled = false`, ширина вне границ, 5-я позиция, 5-е открытие за сутки, превышение `max_hold_usdc` и лимитов агента | Откат с соответствующей ошибкой |
| Generic CPI: SPL Token как цель, Orca в аккаунтах, Token-2022-аккаунт Safe, программа делает `Approve` | `ProgramDenied` / `UseDedicatedInstruction` / `Token2022NotAllowed` / `SafeAccountChanged` |
| CU и размер транзакции для open + increase в одной транзакции | Уложиться в 1.4M CU и 1232 байта (с ALT) |

## 6. Порядок выкатки

Не раньше 2026-11-14: в неделю хакатона апгрейд программы не нужен.

1. Upgrade authority и admin `Config` переводятся на Squads. Treasury — отдельный кошелёк.
2. Форк-тесты из раздела 5 проходят. Внешний аудит — хотя бы `cpi_policy.rs` и `orca.rs`.
3. Upgrade: extend ProgramData, буфер, upgrade. После — сверка хэша, authority и ренты.
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
