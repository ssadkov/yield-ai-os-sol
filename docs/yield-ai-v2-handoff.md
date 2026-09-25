# Yield AI v2 — handoff (2026-09-24)

Передача контекста следующему агенту. Полная техническая запись — [yield-ai-v2.md](yield-ai-v2.md); этот файл — «где мы и куда дальше».

## 1. Что строим

MVP для Colosseum: личный non-custodial **Safe** на Solana (PDA программы `yield_vault`), куда пользователь с мобильного кошелька кладёт USDC. Safe раскладывает USDC по маршрутам (сейчас Kamino USDC, дальше ONyc; JLP и xStocks позже), ведёт учёт в USDC, берёт **5% performance fee только с реализованной прибыли**, владелец должен иметь проверенный путь полного вывода. Выход из Kamino после инвестирования средств пока не проверен.

Продуктовое решение 2026-09-24: пользователь видит одну текущую стоимость Safe в USDC и действие полного вывода. Выбор Kamino vault и перекладка между проверенными vault — внутренняя работа стратегии, без пользовательского выбора vault или слайдера. Оператору нужна вариативность только внутри разрешённого набора; на экране можно показывать состав позиции и историю для прозрачности. Оценка в USDC до выхода не равна гарантированной сумме получения.

Принципы, которые нельзя ломать:

- **Одна подпись владельца на транзакцию.** MetaMask (Solana через Wallet Standard) умеет только `solana:signAndSendTransaction` с явным `chain`; `signTransaction` висит, devnet не поддерживается. Все owner-флоу строятся так, чтобы владелец был единственным подписантом.
- **EVM-кошельки — только источник денег** (CCTP V2 Forwarding минтит USDC прямо в ATA Safe). Safe принадлежит Solana-ключу. EVM-владение и gasless через подписанные владельцем intents (ed25519 в программе) — будущий апгрейд, в контракт пока не закладываем.
- **Агент** (опционально, ключ в Safe) может только вызывать ограниченные маршрутные инструкции в пределах allocation; вывод средств и generic CPI — только владелец.

## 2. Где код

| Что | Где |
|---|---|
| Рабочий worktree | `C:\Users\Sergei\.codex\worktrees\yield-ai-v2\yield-ai-os-sol` |
| Ветка | `codex/yield-ai-v2`, чистая, запушена, HEAD `f784326` |
| **Не трогать** | основной checkout `C:\work\yield-ai-os-sol` (ветка `main`, там чужие незакоммиченные правки в `lib.rs`, IDL, `jupiterBorrow.ts`, `anchorIx.ts`, docs) |

Ключевые файлы:

- `programs/yield-vault/src/lib.rs` — контракт (Anchor 0.32.1).
- `client/src/v2SecuritySmoke.ts` — security-регрессия (localnet и devnet).
- `client/src/v2KaminoFork.ts` — тест Kamino на форке mainnet (`prepare` / `run`).
- `client/src/v2CctpSafeSetup.ts` — Safe для CCTP-теста на devnet.
- `web/src/lib/safeV2.ts` — вся клиентская логика Safe (чтение, сборщики инструкций, Kamino, отправка через Wallet Standard).
- `web/src/components/SafeV2Panel.tsx` — страница `/v2/safe`.
- `web/src/app/api/v2/kamino/route.ts` — прокси Kamino API (`op=metrics|deposit|withdraw`), валидирует layout аккаунтов.
- `web/src/app/api/v2/mainnet-rpc/route.ts` — прокси mainnet RPC с allowlist методов (публичный RPC даёт браузеру 403).
- `web/scripts/kamino-ui-fork.ts` — прогон UI-сборщиков на форке.
- `scripts/grind-vanity.sh` — подбор vanity program ID.
- Лабы: `/v2/lab`, `/v2/cctp`, `/v2/mainnet-probe`.

## 3. Контракт — текущее состояние

**Аккаунты**

- Safe PDA `["vault", owner]`: `bump, owner, agent, allocation_bps [u16;8], last_rebalance_ts, allowed_programs (max 16), route_principal [u64;8]`.
- Config PDA `["config"]`: `admin, treasury, performance_fee_bps, bump`. Максимум fee — 2000 bps. `init_config` может вызвать только upgrade authority; ProgramData парсится вручную, потому что `Account<ProgramData>` добавлял ~58 KB к бинарнику.

**Инструкции**

| Группа | Инструкции |
|---|---|
| Создание | `initialize`, `create_safe_for` (кто-то платит за создание, при закрытии рента возвращается владельцу) |
| Настройки владельца | `set_allocation`, `set_allowed_programs`, `set_agent` |
| Config | `init_config`, `set_config` |
| Деньги владельца | `deposit`, `deposit_spl`, `withdraw`, `withdraw_spl` |
| CPI | `execute_swap_cpi`, `execute_protocol_cpi` (только владелец) |
| Kamino | `kamino_deposit(amount)`, `kamino_withdraw(shares, from_reserve)` |
| Жизненный цикл | `close_empty_token_account`, `withdraw_excess_lamports`, `close_safe` |

**Fee.** `realize_exit`: principal списывается пропорционально выведенным shares; fee = 5% × (получено − principal_out) уходит в treasury из конфига; событие `RouteExit`.

**Защита учёта.** Kamino shares (mint `B9t9…VEnVe`) двигаются только через `kamino_*` и только на канонический ATA Safe. Остальные пути заблокированы:

- `deposit`, `withdraw`, `deposit_spl`, `withdraw_spl` отклоняют shares-mint;
- generic CPI отклоняет программу kVault и shares-ATA.

**Kamino.**

- Программа kVault: `KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd`.
- USDC kVault: `91b1opzHNUQobfLZxGMNYT5qDRKoqV8FdsdQBmH4wBxy`.
- Дискриминаторы и позиции аккаунтов расписаны в `yield-ai-v2.md`.

**Тесты.**

- 6 unit-тестов;
- localnet smoke — PASS;
- форк Kamino — PASS: три попытки обхода отклонены, principal 60 → 0, round-trip стоит ~0.001 USDC;
- UI-сборщики на форке — PASS (транзакции 833 / 966 байт);
- devnet smoke — PASS.

Бинарник ~488 KB.

## 4. Развёртывания

| Что | Состояние |
|---|---|
| Devnet program | `8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5`, authority `8xwj…` (`~/.config/solana/id.json` в WSL). Последний апгрейд `4p4rDWGX…`, хэш совпадает со сборкой. Длина 630000 (уже делали `extend`) |
| Devnet config | `5EjWRU9zFsSH6QavNVB7KpoqrYDHrt7w53Kk8XR5RX1`, admin/treasury `8xwj…`, 500 bps |
| Mainnet program ID | vanity `yie1Jjq6y3rjsiGkgMYnwTveSgpSrSh4n41JHRNyBih`. Keypair только в WSL: `~/.config/solana/yield-v2/vanity/`. **Не деплоен** |
| Старая программа `3Vtz…` | закрыта, рента возвращена |
| Prod web | Vercel `edbiz/yield-ai-os-sol` → `yield-ai-os-sol.vercel.app`, деплой `yield-ai-os-alwo9wzr1-edbiz.vercel.app`. Работает в devnet-конфигурации; Kamino-кнопки там неактивны, потому что Kamino есть только в mainnet |

**Read-only сверка 2026-09-25:** публичный Solana RPC возвращает `Unable to find the account` для `yie1…` и `8xa1…` в mainnet; в devnet `8xa1…` — upgradeable program с authority `8xwj…`, data length 630000. Публичная `/v2/safe` отвечает 200, её JS содержит v2 ID `8xa1…` и devnet USDC mint `4zMMC9…`, но ещё не содержит новую кнопку `Withdraw all USDC`. Перед любым тестом в браузере дополнительно сверить показанный кластер, program ID и mint с кошельком. **Реальные mainnet USDC туда не переводить.** На текущем сайте допустим только отдельный devnet тест с тестовым SOL/USDC и кошельком, который действительно подписывает Solana Devnet; MetaMask для этой пробы не годится (ранее его popup показывал Mainnet).

## 5. Где остановились

Задеплоенная версия (`f784326`) содержит технические кнопки Kamino. В текущем **незакоммиченном worktree** `/v2/safe` уже показывает единую оценку стоимости Safe и кнопку полного вывода USDC; ручные allocation/Kamino-контролы скрыты без `NEXT_PUBLIC_V2_LAB_CONTROLS=1`. Это изменение ещё не деплоилось. Автоматическое перемещение средств агентом между несколькими vaults пока не реализовано.

### Вывод из резерва Kamino: форк пройден, mainnet ещё нет

- KTX API выдавал только `withdraw_from_available`, поэтому `/api/v2/kamino` для выхода переведён на официальный `@kamino-finance/klend-sdk@12.0.0`.
- SDK строит полный `withdraw` из одного или нескольких резервов. Контракт теперь принимает `u64::MAX` на последнем шаге и считает fee по фактически сожжённым shares.
- **Локальный форк PASS:** 100 тестовых USDC в Safe → 60 в Kamino → `invest` (доступный баланс kVault 71.329570 → 26.223325 USDC) → полный `withdraw` из резерва → shares 0, principal 0, Safe 99.998994 USDC. Все транзакции предварительно симулировались.
- **Дополнительный локальный прогон 2026-09-25 PASS:** отдельная симуляция отвергла вывод на ATA владельца вместо Safe; из доступной ликвидности погашены все shares, затем весь USDC переведён из Safe владельцу. Баланс USDC Safe = 0. Повторный `invest` на новом снимке остановил лимит Kamino `InvestTooSoon`, поэтому этот прогон использовал `KAMINO_SKIP_INVEST=1`; он не заменяет успешную проверку выхода из резерва выше.
- UI перед каждым шагом получает новый план с текущими shares и делает одну owner-подпись на транзакцию; после прерывания можно продолжить с наблюдаемого состояния. Количество подтверждений зависит от числа шагов Kamino плюс финальный перевод USDC. Другие токены требуют отдельного вывода; ONyc пока не подключён.
- `npm run build` прошёл; финальный `tsc --noEmit` в WSL прошёл. Внешние RPC давали 429 при prerender, Next повторил запросы. Kamino API route trace — около 117 MiB / 20 900 файлов до упаковки: проверить размер и запуск в Vercel preview до prod. Никаких новых push/deploy или mainnet-транзакций в этом worktree не было.
- Mainnet тест на $1 и перевод performance fee с реальной прибыли ещё не проводились. До их прохождения не включать маршрут для реальных пользователей.

## 6. Куда дальше (рекомендуемый порядок)

1. **Завершить проверку вывода.** Форк после `invest` прошёл; после отдельного согласования mainnet-деплоя и транзакций выполнить малый реальный цикл ($1–5) и проверить fee на положительной прибыли.
2. **Mainnet-деплой под `yie1…`, целевая дата ~2026-09-30.**
   - поменять `declare_id` и `PROGRAM_ID`;
   - `--max-len` ~560K и больше, это ~3.9 SOL;
   - `init_config` с treasury;
   - цикл на $1–5: депозит → Kamino → вывод, включая реальный перевод fee в treasury (сейчас fee проверена только unit-тестами);
   - затем upgrade authority и admin передать в **Squads**.
3. **Точный лимит allocation.** Сейчас лимит считается на один вызов от свободного USDC, поэтому суммарная доля может превысить цель. Нужно считать от стоимости позиции в kVault.
4. Позже:
   - CCTP на mainnet (~$2);
   - маршрут ONyc;
   - deeplink-кнопка для MetaMask mobile (в Chrome модалка не видит MetaMask; в браузере MetaMask всё работает);
   - desktop drag-and-drop UX (правила в `yield-ai-v2.md`);
   - gasless через intents;
   - миграция в основной Yield AI (там подключён Phantom).
   - Несколько Safe на кошелёк — отложено без даты.

## 7. Как запускать (WSL Ubuntu: Rust 1.89, Anchor 0.32.1, Solana CLI 3.1.12)

Сборка — в копии `/tmp/yield-v2-build-20260923-a`: копируем туда `lib.rs` и тесты из worktree, запускаем `anchor build`. Скрипты вызываются так: `wsl.exe -d Ubuntu -- bash -l script.sh`. Рецепты:

- **Локальный тест.**
  1. `cargo test --lib` в `programs/yield-vault`, затем `anchor build`.
  2. Валидатор, где программа грузится как upgradeable, чтобы работал `init_config`:
     ```
     solana-test-validator --reset --upgradeable-program 8xa1D9Tydju5HqnRPVSJwNbjJGAdY55WKjbf9ijpz3D5 target/deploy/yield_vault.so /tmp/yield-v2-admin.json
     ```
  3. `cd client && npx tsx src/v2SecuritySmoke.ts`.
- **Форк Kamino.**
  1. `KFORK_DIR=/tmp/kfork npx tsx src/v2KaminoFork.ts prepare` пишет `clone-programs.txt`, `clone-accounts.txt` и `owner-usdc.json`.
  2. Из `web/` вызвать `KFORK_DIR=/tmp/kfork npx tsx scripts/kamino-full-exit-prepare.ts`: дополнит публичные аккаунты резервов/oracle и обновит warp slot. Этот шаг read-only относительно сети.
  3. `web/scripts/start-kamino-fork.sh` запускает `solana-test-validator` с `--reset`, клонами и локальным бинарником; ledger только в `/tmp/kfork/test-ledger` внутри WSL. Нужны существующие disposable fixture ключи из `/tmp/kfork`; реальные ключи не использовать.
  4. Из `web/` с `V2_MAINNET_RPC_URL=http://127.0.0.1:8899` запустить `npx tsx scripts/kamino-ui-fork.ts`. Он сначала симулирует каждую локальную транзакцию. Если свежий снимок отвечает `InvestTooSoon`, перезапустить валидатор и выполнить `KAMINO_SKIP_INVEST=1` для независимой проверки защиты адреса назначения и Safe → владелец; этот режим не подтверждает выход из резерва.
- **Devnet upgrade.**
  1. Проверить genesis hash (`EtWTRABZ…`).
  2. `solana program deploy <so> --program-id 8xa1… --upgrade-authority ~/.config/solana/id.json`.
  3. `solana program dump` и сверить sha256.
  4. `V2_CLUSTER=devnet V2_PAYER_KEYPAIR=~/.config/solana/id.json npx tsx src/v2SecuritySmoke.ts`.
  5. На «Blockhash not found» уже стоят ретраи; 429 от публичного RPC — норма.
- **Если бинарник вырос:** на devnet `solana program extend 8xa1… <bytes>`.
- **Web prod:** `vercel deploy --prod` с `--build-env NEXT_PUBLIC_PROGRAM_ID=8xa1…`, потому что в env проекта всё ещё старый `3Vtz`. Откат — `vercel promote <deployment>`.
- **Dev-сервер:** запускать из `web/` worktree с очищенным `.next`. Junction на `node_modules` основного checkout даёт дубли React-контекстов — мёртвая кнопка Select Wallet.
- **Web dependencies:** `web/.npmrc` задаёт `legacy-peer-deps=true` для lockfile Kamino SDK. `npm ci --dry-run --ignore-scripts --no-audit --no-fund` прошёл; перед preview нужен обычный `npm ci` и проверка function size.

## 8. Висит на пользователе

- Ротировать Helius API key и смержить https://github.com/ssadkov/yield-ai-os-sol/pull/15 (ключ удалён из кода; история не переписывалась).
- Обновить `NEXT_PUBLIC_PROGRAM_ID` в env Vercel-проекта.
- Запустить grind `yie1d` на домашней машине (`scripts/grind-vanity.sh`).
- Тестовый mainnet-кошелёк — `Dr4fZKKUCMjsyk8dG88VsoYfvLC8PofHGMc2RMd5YZHA`.

## 9. Правила работы с пользователем

- Разделять подтверждённое, оценку и открытую зависимость; давать рекомендацию, а не меню; прямо говорить, что сломано или заблокировано; даты — абсолютные.
- Mainnet-транзакции с реальными деньгами, закрытие программ, prod-деплой, push — только с явного «да» пользователя.
- Сверять новые задачи с `C:\work\context\now.md`, например с дедлайнами Aptos (M2 подтверждён 2026-09-24, ждём выплату).
