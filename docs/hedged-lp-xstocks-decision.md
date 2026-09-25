# Приоритетная идея: Delta-neutral hedged LP на xStocks (Solana LP + Decibel short)

Статус: Priority candidate (зафиксировано 15 июля 2026)

Контекст: выбрано как приоритет по итогам разбора `docs/spyx-yield-pool-design.md` (ySPYx borrow-carry пул) и альтернативных идей доходности на stocks.

## 1. Суть стратегии

Дельта-нейтральный USDC-yield на волатильности токенизированных акций:

1. LP в пул `<STOCK>x/USDC` на Solana (Orca/Raydium/Meteora, возможно через managed CLMM) — доход с торговых комиссий.
2. Short перп на ту же акцию на Decibel (Aptos) — гасит дельту LP-позиции, дополнительно собирает funding (пока long OI преобладает) и поинты Decibel.

```text
доход = LP fees + funding (±) − IL/LVR − ребалансы − операционка
```

Стратегия зарабатывает, когда fee APR пула стабильно превышает стоимость волатильности (LVR). Это short-vol позиция.

## 2. Целевые пары

Приоритет — single-name xStocks с существующим матчинг-перпом на Decibel:

| Spot (Solana) | Perp (Decibel) | Комментарий |
|---|---|---|
| TSLAx/USDC | TSLA-PERP | высокая vol → высокие fees и высокий IL |
| NVDAx/USDC | NVDA-PERP | |
| AAPLx/USDC | AAPL-PERP | ниже vol, стабильнее |
| SPYx/USDC | — | ждёт листинга ETF-перпов на Decibel (заявлены в roadmap) |

Хедж SPYx корзиной single-name шортов не делаем: топ-имена покрывают ~30–35% индекса, tracking error велик.

## 3. Почему приоритет (vs ySPYx borrow-carry)

- Реализуемо сейчас: пары spot+perp существуют, не нужен новый смарт-контракт для managed-версии — исполняется off-chain keeper'ом.
- Потенциально двузначный APY против ~4% net у ySPYx при сегодняшних ставках.
- Нет liquidation-машинерии ySPYx-пула (epoch, NAV oracle, Jupiter decoder) на старте.
- Бонус временный, но реальный: points program Decibel на шортовой ноге.

Концептуальная оговорка: это market-neutral USDC-продукт — экспозиции на акцию у пользователя нет. Конкурирует с Kamino USDC (~7%), а не с «держу акции + carry».

## 4. Вторая очередь: borrow-слой сверху

«Yield на stocks с сохранением экспозиции» возможен как надстройка:

```text
SPYx collateral (Jupiter Borrow vault 78)
  -> borrow USDC (target LTV 50–55%, см. spyx-yield-pool-design.md)
  -> USDC уходит в hedged LP стратегию как earn destination
```

То есть hedged LP становится одним из earn-маршрутов для ySPYx-пула вместо/рядом с Kamino. Это сложнее (вся liquidation/NAV-машинерия из спеки ySPYx) — делаем после того, как базовая стратегия проверена на собственном/малом капитале.

## 5. Ключевые риски

1. **Short vol**: если fee APR пула не покрывает LVR — стратегия убыточна. Решается замером до постройки (см. п.6).
2. **Кросс-чейн маржа**: LP на Solana, маржа шорта на Aptos, кросс-маржи нет. Нужен буфер маржи ~35–40% капитала на Aptos и канал пополнения (Circle CCTP, минуты задержки = риск ликвидации при гэпе). Keeper на обеих сетях.
3. **Venue risk Decibel**: mainnet с конца февраля 2026, риск ADL, ёмкость = OI конкретного рынка, токена нет. Капнуть долю на venue.
4. **Динамическая дельта CLMM**: частые ребалансы фиксируют IL; частота ребаланса — ключевой параметр для backtest.
5. **Weekend/hours**: Decibel торгует 24/7 (плюс), но price discovery перпа против AMM-спота в нерыночные часы может расходиться.
6. **Freeze authority xStocks** (Token-2022, эмитент Backed) — единая точка заморозки spot-ноги.

## 6. Следующие шаги (до кода)

1. Снять фактический fee APR и объёмы пулов TSLAx/NVDAx/AAPLx/SPYx на Solana (история, не снапшот).
2. Снять funding rates и OI по TSLA/NVDA/AAPL перпам на app.decibel.trade за возможный период.
3. Оценить LVR по историческй волатильности каждого имени; собрать таблицу экономики на $100k по парам.
4. Выбрать 1–2 пары с лучшим `fees − LVR` спредом.
5. Прототип keeper: дельта-расчёт LP позиции, ребаланс-триггер, маржа-мониторинг на Decibel (gmsol-sdk не нужен — Decibel это Aptos, смотреть их SDK/API).
6. Ручной прогон на малом капитале до любой автоматизации.

## 7. Ссылки

- Спека ySPYx (вторая очередь): `docs/spyx-yield-pool-design.md`
- Decibel: https://app.decibel.trade/trade , https://docs.decibel.trade/
- Decibel mainnet launch: https://chainwire.org/2026/02/26/decibel-launches-fully-onchain-perpetuals-exchange-on-aptos-mainnet/
- xStocks (Backed): https://solana.com/news/case-study-xstocks
