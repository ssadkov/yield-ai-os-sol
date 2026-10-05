# Exponent PT-ONyc в личном Solana Safe: исследование и план

Дата первоначальной проверки: 2026-09-30, Asia/Qyzylorda. Ниже — историческое read-only исследование и исходные предложения. Реализованный узкий MVP, уточнение indexed wrapper units, fork/HTTP проверки и актуальные ограничения описаны в [exponent-onyc-mvp.md](./exponent-onyc-mvp.md). Более широкий registry/fee план ниже не реализуется в пилоте. Mainnet-транзакции и upgrade не выполнялись.

## Решение для первого маршрута

Первый кандидат: PT-ONyc-10JAN27 на Exponent, без плеча и займов Loopscale. Покупка PT, досрочная продажа PT и погашение должны оставлять все промежуточные активы в Safe. Отдельный owner-signed вывод завершает маршрут в USDC ATA владельца.

Это выбор для проверки интеграции, а не утверждение, что рынок лучший по риску или доходности. ONyc несёт риск underlying reinsurance/NAV, исполнения контрактов и ликвидности конвертации в USDC.

## Что означает USDC в Loopscale

[Ссылка пользователя](https://app.loopscale.com/loops/onyc-10jan27-usdc) — leveraged Loop с залогом PT-ONyc и заёмной валютой USDC. В форме Deposit доступны PT-ONyc и USDC; переключение на USDC подтверждено без подключения кошелька.

Снимок UI: max net APY 21.6%, average 20.54%, max leverage 3.3x, average 3.0x. Available liquidity 1,695,894.14 USDC — кредитная ликвидность; её нельзя считать глубиной продажи PT или ONyc. UI также описывает PT как погашаемый в USDC. Для реализации этот текст недостаточен: on-chain SY adapter выдаёт ONyc.

Следовательно, USDC-вход в интерфейсе поддерживается, но он не отменяет конвертацию ONyc и не делает PT прямым требованием к USDC. Плечо добавляет отдельные borrow/repay, LTV/liquidation и maturity-риски, которые в первый маршрут не входят.

## Проверенный рынок и on-chain идентичность

| Поле | Значение |
| --- | --- |
| Exponent market UI | [ONyc-10JAN27](https://app.exponent.finance/market/income/onyc-10JAN27) |
| Core program | ExponentnaRg3CQbW6dqQNZKXp7gtZ9DGMp1cwC4HAS7 |
| Core vault | 7f1PgxY3kGsPqLAKpwcduZkcBEhpjMz7U1iJ4pcCCzDy |
| PT mint | HH7FiYbEfDwQoK2ZJpkMz1T6wG6TqPsWcxWCtEVgigrZ |
| YT mint | GFpXWuDCm7QMjkYbMveNZoLzybqJaginDDvuX3bJqgLF |
| SY mint | G1qbuP11CdquJCzuDjruWqatQAHroajmxhLfeQVgHosF |
| Generic SY program | XP1BRLn8eCYSygrd8er5P4GKdzqKbC3DLoSsS5UYVZy |
| SY metadata | BmLiVHRb9ppTrEA5jhTgNJ2WFtjUZEkfzJZGswEidxzu |
| Underlying / yield_bearing_mint | 5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5 (ONyc) |
| Vault ALT | 3jWaCBKwrMgRVfZGja1wXacDPb3kN5GGxRbNQTxvnPGU |
| Maturity UTC | 2027-01-10 13:00:00 |
| Maturity Asia/Qyzylorda | 2027-01-10 18:00:00 |
| ONyc / PT decimals | 9 / 9; USDC uses 6 |

Проверка: публичный getProgramAccounts для Exponent Core с mintPt memcmp offset 104; чтение полей по codec официального SDK 0.9.29. Затем getProgramAccounts Generic SY с yield_bearing_mint offset 129; SY mint совпал с Core vault, underlying оказался ONyc. Mint-аккаунты PT/ONyc проверены через jsonParsed getMultipleAccounts. Оба — обычный SPL Token, у ONyc есть freeze authority.

Официальный SDK `@exponent-labs/exponent-sdk@0.9.29` определяет base asset Generic flavor через `account.yieldBearingMint`. Wrapper buy/sell и merge-to-base работают с этим mint. Нужно сохранить различие между USD-номиналом principal и фактически выдаваемым ONyc: нельзя считать 1 PT = 1 ONyc.

## Рыночный снимок и альтернативы

| Кандидат | Implied APY UI | Maturity UI | Комментарий для выбора |
| --- | ---: | --- | --- |
| PT-ONyc | 12.53% | 10 Jan 2027 | Первый PoC; liquidity UI $14.69M, underlying APY 11.02% |
| PT-srONyc | 8.06% | 10 Jan 2027 | Senior exposure; liquidity UI $1.83M, дополнительный tranche layer |
| PT-srEHYUSD | 13.48% | 12 Dec 2026 | APY выше ONyc; другой underlying, нужен отдельный risk/exit review |
| PT-USX | 6.38% | 1 Dec 2026 | Более короткий срок; другой adapter/underlying |
| PT-sUSD.infra | 14.92% | 16 Jan 2027 | Новый рынок; высокая ставка сама по себе не основание выбора |

Источники ставок: официальный Exponent UI на дату проверки. Они меняются; таблица не является исполнимой котировкой. SOL-рынки BulkSOL/xSOL не сравниваются как долларовая fixed-income стратегия без валютного риска.

OnRe API в ходе проверки: `live-nav = 1.150884088`, `live-apy = 0.1102`. Это текущие метрики ONyc, а не доходность покупки PT.

## Котировки без исполнения

Exponent UI, без кошелька, Instant:

- Продажа 1,000 PT: 840.2816 ONyc, примерно $967.07, executable implied APY 12.76%, route Exponent Order Book.
- Покупка за 868.897 ONyc (около $1,000 по NAV): 1,032.8206 PT, executable implied APY 12.28%, maturity quote 1,032.8207 USD **on ONyc**, route Exponent Order Book.

Это независимые UI-котировки, не атомарная проверка покупка-продажа. Разницу 1,000 PT против $965 USDC нельзя называть убытком 3.5% от вложенного капитала: 1,000 — номинал PT, а cost basis покупки ниже номинала.

Jupiter `/swap/v2/order`, без taker и без transaction, slippageBps=50, существующий серверный ключ использован только в заголовке:

| Котировка | Amount in | Expected out | Threshold |
| --- | ---: | ---: | ---: |
| USDC → ONyc | 1,000 USDC | 868.766337064 ONyc | 864.422505378 ONyc |
| ONyc → USDC после UI-продажи 1,000 PT | 840.2816 ONyc | 965.083092 USDC | 960.257676 USDC |
| ONyc → USDC для ~$1,000 NAV | 868.897 ONyc | 997.948508 USDC | 992.958765 USDC |

HTTP 200, router metis, mode manual, feeBps=10. Вход — Whirlpool; выход выбирал Whirlpool и/или Raydium CLMM/AlphaQ с промежуточным mint. Не считать эти маршруты автоматически разрешёнными executor: прежде требуется строгая проверка accounts/instruction layouts и список разрешённых DEX/mints. `/order`-котировка не доказывает, что `/build` CPI-маршрут идентичен по цене или доступен для PDA.

Котировки подтверждают доступность отдельных обменов на этой сумме в момент проверки. Не проверены другие размеры, будущая ликвидность, полная сериализация Safe-транзакции, CU/размер и атомарность всех шагов.

## Текущий Safe: какая версия является базой

Основной checkout `main` и remote main: b2ed57568b6f582a72fd923940ecc928d8fcdad8. В нём нет ExecutorLimits; `ROUTE_ONYC=1` только зарезервирован. Generic CPI owner-only; единственные типизированные yield actions — Kamino. `realize_exit` уже рассчитывает комиссию с положительного результата пропорционального principal, но не является готовым журналом PT/SY/ONyc состояния.

Remote `codex/yield-ai-v2-executor-limits`: e83852b9857bf6e4c3c1a30ba19e3ae93d67a604, проверен через ls-remote. Ветка содержит ExecutorRegistry/ExecutorLimits, ограничения action/rolling 24h/principal и сохранённый старый Kamino owner ABI. Именно от неё создана ветка исследования `codex/exponent-fixed-income` в отдельном managed worktree.

Read-only Mainnet ProgramData Safe: `GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY`, space 620533, code size 620488, slot 450933736. SHA-256 code (после 45-byte header): `7f0da515e6a1d4249b5748457e279cc0636867cd43d973522da8e698ac80ebe9`. Он совпадает с documented deployed binary этой ветки. Более старые memory-записи о pending upgrade уже не описывают live state. В этом исследовании upgrade не выполнялся.

## Маршруты для реализации

1. Вход: USDC Safe → ONyc Safe → SY/market operation → PT в каноническом ATA Safe. Перед операцией проверить весь набор разрешённых программ, market/vault/adapter/escrow/mints/ATAs. Фактически списанный USDC — cost basis, фактически полученный PT — позиция.
2. Досрочный выход: PT Safe → рыночная продажа → ONyc Safe → USDC Safe. До maturity нужен рынок, не PT-only redemption. Результат должен измеряться по фактическому net USDC всему маршруту.
3. Maturity: PT Safe → погашение через Core → SY/ONyc Safe → USDC Safe. Проверить PT-only redemption на локальном форке с Clock после expiry и пустым YT balance; не требовать ранее купленного YT для fixed-income позиции.
4. Вывод: отдельный owner-signed withdraw USDC Safe → канонический USDC ATA владельца. Executor имеет право вернуть активы в Safe, но не отправлять их произвольному получателю.

Maturity и liquidity считаются по on-chain Clock/state. После expiry торговый рынок нельзя использовать как обязательный путь выхода. Если конвертация в USDC недоступна, нужен явно учтённый `redeemed_pending_usdc` и owner recovery; комиссия не начисляется на промежуточный ONyc.

## 5% комиссии с прибыли и 5% допустимого убытка

Первая стадия: новая Exponent position policy `performance_fee_bps=0`. Будущая модель: 500 bps **от положительной реализованной прибыли в USDC**, а не 5 процентных пунктов APY и не 5% всей суммы вывода. Не менять глобальный Config так, чтобы случайно отключить fee Kamino.

Пример: invested 1,000, settled 1,100 USDC → profit 100, fee 5, owner net 1,095. Settled 950 → fee 0. На UI отдельно показывать текущую фактическую fee и прогноз после планируемых 5%; пока fee=0 нельзя подписывать прогноз как уже удерживаемую комиссию.

Отображение PT income: сначала вывести прогноз USDC при maturity с затратами входа/выхода, применить performance fee к прибыли, затем annualize за оставшийся срок. Приближение net APY = gross APY × 0.95 допустимо только как явно отмеченная оценка. ONyc live APY не заменяет PT quote APY.

Для раннего выхода `max_loss_bps=500` — политика относительно allocated USDC cost basis проданной части. Это не default slippage=5% и не обещание, что рыночные потери никогда не превысят 5%. Если конечная сумма ниже порога, executor операция откатывается; owner может отдельно выбрать иной лимит.

`min_usdc_out = max(quote-derived minimum, 95% allocated cost basis)` с однозначным указанием gross/net и fee. В пилоте fee=0; при включении fee порог оценивается после fee. Slippage каждого leg ограничен отдельно небольшим owner-approved значением, а общий minimum проверяется on-chain. Итоговый minPtOut на покупке обязателен.

Partial exit требует детерминированной cost-basis allocation и переноса остатка округления на final exit. Для обещания «5% от прибыли всей позиции» нужны cumulative realized PnL, carry-forward losses и already-charged profit: независимый fee от каждого прибыльного partial exit может взять комиссию при совокупном убытке. Выбрать final-close settlement либо корректную loss-carry/refund policy до включения ненулевой fee.

## Типизированные instructions и учёт

План, ещё не реализовано:

- `exponent_buy_pt(usdc_in, min_pt_out, deadline, market_id)`.
- `exponent_sell_pt(pt_in, min_usdc_out, deadline, market_id)`.
- `exponent_redeem_pt(pt_in, min_usdc_out, deadline, market_id)` и отдельно ограниченный finalize-to-USDC, если полный atomic route не помещается.
- Position PDA `[exponent_position, safe, vault]`: market/vault/PT/SY/base mints, maturity, tracked_pt, remaining_cost_basis_usdc, realized_pnl, fees_paid/fee-policy snapshot, pending SY/ONyc, state и bump.
- Market registry/policy с проверенными адресами; новые maturity — отдельные позиции, а не переписывание одного маршрута ONyc.
- Executor: existing registry approval + assigned agent + enabled policy; action/24h/total principal + allocation cap + maturity/market authorization + end-to-end loss/slippage/deadline + balance deltas. Split legs не должны обходить общий бюджет и fee accounting.
- On-chain программа сама собирает discriminator/typed amount data. Off-chain SDK accounts считаются недоверенными и сверяются с canonical registry/state; нельзя возвращать произвольные CPI bytes executor.
- Generic CPI и token withdrawals должны учитывать защищённые PT/SY/pending-ONyc accounts, чтобы учёт/fee не обходились прямым transfer/burn/delegate/close. Owner recovery должен оставаться доступным и явно завершать учёт.
- Не менять существующий Kamino account list / owner ABI и правила комиссии Kamino.

## API и файлы следующей стадии

План изменений только в worktree; `/api/v1` не затрагивать:

| Компонент | План |
| --- | --- |
| `programs/yield-vault/src/lib.rs` или отдельный модуль | market registry, Position, typed actions, limits/account validation |
| `web/src/lib/exponentV2.ts` | pinned SDK adapter; explicit payer owner, authority Safe PDA; ATAs/ALTs |
| `GET /api/v2/exponent/markets` | reviewed market registry + live state/decimals/maturity/availability |
| `GET /api/v2/exponent/quote` | buy/sell/redeem; raw integer strings; expected/minimum outputs for each leg and final USDC; actual vs projected fee; basis/loss floor; quote slot/TTL |
| `POST /api/v2/exponent/transactions` | quote reference + fresh revalidation; unsigned v0 tx, ALTs, blockhash/lastValidBlockHeight, required signers, simulation result and balance-delta preview; no send/sign |
| `web/src/lib/safeV2.ts` | typed clients/read Position; preserve Kamino compatibility |
| `client/src/v2ExponentFork.ts` | one reviewed market end-to-end fork lifecycle and adversarial cases |
| docs | execution examples, fee math, loss-vs-slippage, lifecycle, production gates |

Use SDK `payer=owner`, inner authority/owner = Safe PDA. ATA creation cannot require an outer PDA signature. All amount fields bigint/raw decimal strings; no JS Number conversion. Pin SDK 0.9.29 or explicitly reviewed replacement; SDK depends on Anchor 0.30.0 while project uses 0.32.1, so validate boundaries before mixing Program instances.

## Обязательные проверки следующей стадии

- Локальный Mainnet-account fork: buy → PT Safe → partial/full sell → USDC Safe → owner; buy → time advance → PT-only redeem → USDC → owner. Mainnet simulation не может сама продвинуть дату до Jan 2027.
- Execute actual upstream Exponent Core/orderbook/CLMM/Generic SY and выбранный DEX binaries/accounts; mock tests отдельно и явно помечены, не заменяют полный fork.
- Repeat sizes $100/$1,000/$10,000; compare quote minimum, actual deltas, CU, v0 serialized size, SOL fees and rent/recovery.
- Wrong program/discriminator/market/maturity/adapter/mint/escrow/ALT/account/recipient; чужой Safe; signer spoofing; unsupported route/DEX/mint; frozen account; donated PT/untracked shares.
- Missing/unapproved executor, pause, owner settings, per-action/24h/principal/alloc caps; repeated/split deposits and stale quote/deadline.
- Market loss >5% must reject executor exit under that policy; configured owner exit/recovery remains possible.
- Insufficient depth, missing route, failed final swap → atomic rollback or explicit recoverable pending state. Fee only after net USDC settlement; residual dust cannot close an unsettled position.
- Fee=0 pilot, fee=500 profit/loss/breakeven/partial rounding, repeated settlement, partial loss then profit, accidental global Kamino fee changes.
- Regression current owner Kamino ABI and existing Safe lifecycle.

## Первичные источники

- [Exponent programs](https://docs.exponent.finance/developers/exponent-programs), [post maturity](https://docs.exponent.finance/developers/learn/post-maturity), [buy PT wrapper](https://docs.exponent.finance/developer-clmm/typescript/instructions/ix-wrapper-buy-pt), [sell PT wrapper](https://docs.exponent.finance/developer-clmm/typescript/instructions/ix-wrapper-sell-pt), [merge to base](https://docs.exponent.finance/developer-core/typescript/instructions/ix-merge-to-base).
- Official npm SDK/Generic SY SDK/IDL 0.9.29, downloaded to temp for source inspection; no package lifecycle scripts executed.
- [OnRe token reference](https://docs.onre.finance/technical-resources/token-configuration-and-reference), [live NAV](https://core.api.onre.finance/data/live-nav), [live APY](https://core.api.onre.finance/data/live-apy), [access models](https://docs.onre.finance/for-capital-providers/open-access-vs-institutional-access). Primary OnRe redemption availability/eligibility differs between documents and access modes; do not assume permissionless Safe redemption at NAV. DEX exit is the initial candidate.
- [Jupiter Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute), [Build](https://developers.jup.ag/docs/swap/build): raw instructions for CPI require separate review from quote-only `/order`.
- [Loopscale overview](https://docs.loopscale.com/introduction/overview), official apps linked above, public Mainnet RPC state.

Mainnet transactions, deployment and upgrade остаются за отдельным согласованием. Research result does not claim a completed Safe route or production readiness.
