# Yield AI v2 — лимиты executor на каждый Safe

Контракт этой ветки **развёрнут в Mainnet** под `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih` 2026-09-27. Интерфейс Production ещё не переключён на эту ветку. Владелец пилотного Safe уже создал политику 1000/1000/1000 USDC. Сервис executor не запущен, а allocation Safe равна нулю, поэтому автоматического входа в Kamino нет.

## Права и исходные значения

- Лимиты принадлежат конкретному Safe и лежат в PDA `executor_limits` с seeds `["executor_limits", safe]`. Их создаёт владелец; только владелец может менять значения и ставить executor на паузу. Админ по-прежнему управляет глобальным whitelist, но не повышает личные лимиты Safe.
- При создании нового Safe через актуальный интерфейс `initialize_with_limits` три поля автоматически равны **1000 USDC** (`1_000_000_000` базовых единиц, 6 decimals): максимум одного действия, общий объём последних 24 часов и максимум одновременно учтённого вложенного principal. Политика включена, но нулевая allocation всё равно запрещает автоматический вход.
- Для Safe, созданного до upgrade, политики ещё нет. Любая executor-signed операция отказана до того, как владелец одной транзакцией создаст её через «Save limits». В интерфейсе предзаполнены те же 1000 USDC; каждое поле можно изменить отдельно. Ручные owner-signed действия не требуют политики и не расходуют бюджет executor.
- Создание политики у старого Safe требует `0.003017520 SOL` rent для 466-байтного аккаунта по read-only Mainnet RPC, плюс сетевую комиссию. Этот rent возвращается владельцу, когда он закрывает пустой Safe вместе с политикой.
- Кнопка «Pause executor» подписывает `set_executor_limits(..., enabled=false)`. Пауза блокирует вход и выход executor, но не владельца. Отзыв адреса администратором или владельцем остаётся дополнительным уровнем защиты.

## Совместимость с уже открытым интерфейсом

- Старый `initialize` сохраняет прежний список аккаунтов и создаёт Safe без политики. Такой Safe безопасно закрыт для executor до отдельной owner-signed настройки лимитов. Новый интерфейс вызывает `initialize_with_limits` и создаёт Safe с политикой за одну подпись.
- Старые owner-signed `kamino_deposit` и `kamino_withdraw` сохраняют прежний формат аккаунтов. Executor обязан передать writable PDA лимитов **последним дополнительным аккаунтом**; контракт проверяет его PDA, owner, discriminator и Safe и не пересылает его в Kamino CPI. Отсутствие PDA блокирует executor.
- Старый `close_safe` с двумя аккаунтами продолжает работать. Новый интерфейс добавляет PDA лимитов последним дополнительным аккаунтом и возвращает его rent одновременно с закрытием Safe. Если Safe закрыт старым интерфейсом, PDA лимитов остаётся; владелец может заново создать Safe, затем закрыть его актуальным интерфейсом и вернуть rent.

## Что учитывается on-chain

| Действие executor | Объём одного действия | Учёт за 24 часа | Позиция |
|---|---:|---:|---:|
| `kamino_deposit` | Фактически списанный из Safe USDC | Та же сумма | Новый суммарный `route_principal` не выше лимита |
| `kamino_withdraw` | Фактически полученный Safe USDC **до** performance fee | Та же сумма | Выход не блокируется уже превышенным principal |

В обоих случаях проверка идёт **после CPI в той же атомарной транзакции**: если Kamino вернул неожиданную сумму и лимит нарушен, вся транзакция откатывается. Перекладывание «войти → выйти → войти» расходует бюджет на каждом шаге. 25 часовых bucket'ов консервативно покрывают последние 24 часа: граничный час сохраняется целиком, поэтому операция может оставаться в расчёте до одного дополнительного часа и не выпадает раньше срока. Изменение лимитов не обнуляет уже учтённый объём.

При одинаковых значениях 1000/1000 USDC executor, вложив 1000 USDC, не сможет сам полностью погасить позицию в ближайшие 24 часа: вход уже занял весь общий бюджет. Владелец всегда может подписать выход сам или повысить дневной предел. Интерфейс должен показывать это при настройке, чтобы пауза executor не воспринималась как блокировка средств.

Owner allocation контролируется отдельно. Для executor новый депозит проверяет долю по USDC cost basis: `principal_after / (idle_USDC_after + сумма principal всех маршрутов) <= target_bps / 10_000`. Это пресекает обход повторными депозитами. Cost basis не равен текущей рыночной стоимости Kamino shares; для точной доли по NAV понадобится отдельная проверенная оценка позиции. Абсолютный лимит principal ограничивает вложенный номинал независимо от этой оценки.

Сейчас у executor **нет swap-инструкции**: `execute_swap` и generic CPI разрешены только владельцу. Когда появится типизированный USDC swap или другой executor-маршрут, он обязан использовать тот же PDA и общий USDC-бюджет по фактическому USDC notional до включения в whitelist. Нельзя считать лимитом только проверку в off-chain worker.

## Локальные результаты 2026-09-27

- `cargo test -p yield-vault --lib`: **9/9 PASS**. Проверены повторные операции в одном окне, границы action/position, пауза и повторный депозит при target 50%.
- `NO_DNA=1 anchor build`: **PASS**; итоговый SBF `.so` — `620488` байт, SHA-256 `7f0da515e6a1d4249b5748457e279cc0636867cd43d973522da8e698ac80ebe9`. Считанный после upgrade Mainnet-байткод совпал с ним побайтно по размеру и SHA-256. Web и client `tsc --noEmit` — **PASS** в WSL.
- `client/src/v2SecuritySmoke.ts` на отдельном локальном validator: **PASS** для owner-only изменения лимитов, проверки 1000 USDC по умолчанию, паузы, отказа Safe без политики, создания и закрытия Safe старым списком аккаунтов, возврата policy rent и остальных ранее существовавших прав. Тест использовал одноразовые локальные ключи.
- `client/src/v2KaminoFork.ts` на локальном форке Mainnet: **PASS**. При 100 USDC тестового депозита executor вложил 60 USDC при target 60%; попытка следующего депозита 1 USDC отвергнута. Предел одного действия 50 USDC отклонил попытку вложить 60 USDC, а предел 100 USDC за 24 часа отклонил полный выход после входа на 60 USDC. После возврата лимита к 1000 USDC executor полностью вышел. Затем owner выполнил депозит 1 USDC и полный выход прежним форматом аккаунтов; в Safe осталось `99.997990` USDC, shares и principal стали нулевыми. Это локальный тест, не Mainnet-транзакция.

## Mainnet upgrade 2026-09-27

Перед отправкой проверены Mainnet genesis `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`, upgrade authority и плательщик `8xwjNX3hWwG9BEBVL3SCZqtsqPGgA8ARXq7eSzCTee9A`, SHA-256 локального бинарника, баланс `3.929490300 SOL` и успешный Preview PR #20. Unsigned симуляция `ExtendProgram` на `83584` байта ранее завершилась с `err=null`, `2520 CU`. Старый Mainnet байткод `536904` байта с SHA-256 `37bcd17d1a92fe05665eed207e5a0167062c886dc3efa6df28cbbbb99a307042` сохранён в `C:\Users\Sergei\AppData\Local\Temp\yield-v2-mainnet-before-executor-limits-37bcd17d1a92.so` для возможного отката.

- [Расширение ProgramData](https://solscan.io/tx/2Lygao7q74BtrGcJXZY3qX4HSzMLXYGpadNPjApxchQFaVXZt4qp27ziq7KypqQ25RxUY9sURW2NikYcZCUTGjsz), slot `450933460`, `extendProgram` на `83584` байта, finalized без ошибки. ProgramData `GYgDydSMpo3RbbPRgg4bA71czMM7PKQbLqWyDjWb2ukY` стал `620533` байта. Дополнительный постоянный rent — `0.424606720 SOL`, комиссия транзакции `0.000005 SOL`.
- [Upgrade программы](https://solscan.io/tx/eP49ZLETJdaNWSfUcqiSNkaG4KSAh3KXnucuccdAqhN7fw7RbhZRmw2RpyG32LiKxmSKGt9yvGxyXruon6wzDWQ), slot `450933736`, `upgrade`, finalized без ошибки. Размер активного кода `620488` байт, SHA-256 выгруженного из Mainnet кода **`7f0da515e6a1d4249b5748457e279cc0636867cd43d973522da8e698ac80ebe9`** совпал с локальным бинарником. Upgrade authority осталась `8xwj…`. Временный buffer `4p8DYZPzZuWR31yj22Nu4RDqAQsYBGEUtgBZxKK93uPb` закрыт, его rent возвращён.
- После двух шагов deployer имел `3.501793581 SOL`; уменьшение от состояния после пополнения составило `0.427696719 SOL`, включая постоянный rent и суммарные комиссии/издержки загрузки. Это не затрагивало USDC пользователей.
- Пилотный Safe `FuDCEZBgp8gxP3gafnHbUJRgGW63VAmtZwsjus1U5qSZ` остался аккаунтом программы `yie1…` с корректным discriminator `Vault` и размером `677` байт. Средства и Kamino-позиция самим upgrade не перемещались.
- Владелец [создал policy PDA](https://solscan.io/tx/4SyTHxyHo5NC9aqBJdoiHHaMVAqW1UGafLmhLocKAUaBKaczarbdMxrjNPwZcnZzBUcCpXWFtu31WYaem9pRpGS9) `DQ9Y8Fd1AKg7UZVcyuttw2B9Tgit8EJawu1W9LrzbUd8`, slot `450938049`, finalized без ошибки. On-chain проверены `enabled=true` и три значения `1000 USDC`. Из кошелька владельца списалось `0.003172520 SOL`: `0.003017520 SOL` rent в PDA и `0.000155 SOL` сетевая комиссия.
- После установки policy read-only snapshot Safe: `1 USDC` idle, `1.891798` Kamino shares, учтённый principal `2 USDC`, Kamino allocation `0 bps`. Реальный [депозит 2 USDC](https://solscan.io/tx/29RrTVDqQixj8zcBdyCT35YS6ZgTuusSLKYuLLhYPEQMUcrVawnJLFYbmW5U4aAEZXNf9yTVeYTVLwahuptsBJZG) был до этого upgrade; этот snapshot предшествовал живому выводу ниже.

Программа после upgrade проверена read-only через Helius; создание policy и owner-signed полный вывод текущей позиции уже проверены Mainnet-транзакциями. Точная сборка не проходила отдельный upgrade в Devnet; локальные validator и Mainnet-account fork тесты описаны выше.

### Живой полный вывод из Kamino и Safe

- [Погашение Kamino shares](https://solscan.io/tx/5wXWkCcmZBAzj7QDuvhPytrSqAZK44uqmmpxstBcPikRo7yo9TvmvKEaoCrZWSqCv6qmPv9HDAetguhzQkn9DVZM), slot `450943512`, finalized без ошибки: `1.891798` shares списано из Safe, `1.999291 USDC` зачислено в Safe. Учтённый principal перед выходом был `2 USDC`, поэтому фактическое отличие составило `-0.000709 USDC`; performance fee с прибыли не взималась. Сетевая комиссия владельца `0.000380 SOL`, фактический расход `154713 CU`.
- [Вывод USDC владельцу](https://solscan.io/tx/2atdNN4G9FauvvuTqhQbhF4LkmV7Hq5ioA6K9YeAY1L79ZRRfBitjerrWcmo2YJwdXt1VfufsbEdLhur97bZG5sC), slot `450943541`, finalized без ошибки: все `2.999291 USDC` (погашение плюс прежний `1 USDC` idle) переведены из Safe в USDC ATA владельца `EP9f…`; комиссия `0.000155 SOL`, `17219 CU`.
- Повторное finalized чтение: в Safe `0` Kamino shares, `route_principal[0]=0`, `0` USDC; USDC ATA владельца содержит `13.119247 USDC` на момент проверки. Policy осталась `enabled=true`, лимиты `1000/1000/1000 USDC`, allocation Safe `0 bps`. Пустой shares ATA ещё существует; его rent не включён в указанные сетевые комиссии.

Preview PR #20 сначала упал на Vercel на этапе сбора страницы: ветка наследовала глобальный `NEXT_PUBLIC_PROGRAM_ID`, который не совпадал с IDL `yie1…`. Для ветки `codex/yield-ai-v2-executor-limits` добавлена отдельная Preview-переменная `NEXT_PUBLIC_PROGRAM_ID=yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`. Повторный Preview build **PASS**; Production-переменные не менялись.

## Порядок выпуска

1. Owner-signed Mainnet путь **Withdraw all USDC** для пилотного Safe пройден: Kamino shares, principal и Safe USDC обнулились; фактический вывод владельцу подтверждён выше.
2. Провести малый agent-signed пилот после осознанной установки owner allocation и отдельно проверить отклонение операций сверх action/24h/principal лимитов; сервис executor пока не запускать.
3. Согласовать переключение Production UI после проверки остальных release gates и PR #19. PR #20 остаётся draft поверх PR #19 до решения о выпуске.
