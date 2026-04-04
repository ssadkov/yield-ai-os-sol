# 🧠 Yield AI — Solana AI Vault

*Read setup and development instructions at the bottom of the page.*

Yield AI — это интеллектуальное хранилище (Vault) на базе Solana, управляемое искусственным интеллектом. Проект позволяет пользователям депонировать USDC, выбирать инвестиционную стратегию (Conservative, Balanced, Growth) и автоматически ребалансировать портфель с помощью маршрутизации Jupiter API, обменивая активы строго внутри контролируемого смарт-контракта.

## 🚀 Текущий функционал (Что уже умеет проект)

### ⛓️ Смарт-контракт (Solana / Anchor)
Реализован надежный и безопасный смарт-контракт (Vault), где средства хранятся на неэкспортируемом адресе PDA (Program Derived Address), привязанном к кошельку пользователя. Никто, кроме программы и владельца, не имеет доступа к выводу средств.

- **`initialize`**: Создание персонального хранилища Vault для пользователя. Включает привязку к кошельку владельца, выбор базовой стратегии, назначение доверенного AI-агента и инициализацию `whitelist` (белых списков) разрешенных смарт-контрактов DEX.
- **`deposit`**: Депозит USDC со счета пользователя на счет Vault PDA.
- **`withdraw` / `withdraw_spl`**: Безопасный вывод. Только владелец (Owner) может вывести USDC или другие SPL/Token-2022 токены из Vault обратно на свой личный кошелек.
- **`set_allowed_programs`**: Владелец может обновлять список разрешенных контрактов, с которыми может взаимодействовать Vault.
- **`execute_swap_cpi`**: Внутренняя функция проведения безопасных обменов токенов. Использует CPI (Cross-Program Invocation) для вызова агрегатора Jupiter. **Безопасность**: Работает исключительно с программами из белого списка. Инициировать обмен может AI-агент или владелец, но средства никогда не переводятся на кошелек агента.

### 💻 Пользовательский интерфейс (UI, Next.js)
Современный дашборд для наглядного управления активами и взаимодействия с ИИ.

- **Интеграция кошельков (Wallet Adapter)**: Подключение кошельков Solana и подписание транзакций для депозита/вывода.
- **Аналитика портфеля**:
  - Наглядное отображение активов на личном кошельке и внутри Vault PDA.
  - Построение динамических круговых диаграмм (Pie Chart) текущей аллокации активов.
- **Реальная доходность (APR)**: Загрузка и отображение актуальных метрик доходности (APR / APY) для стратегий с доходными токенами (например, USDY, jitoSOL, Onyc).

### 🤖 AI Чат и Автоматизация (Vercel AI SDK)
Проект содержит продвинутого ИИ-агента, интегрированного в UI через чат, который работает как финансовый советник и автономный исполнитель on-chain действий.

- **Контекстно-зависимый Чат**: Чат-бот (используя OpenRouter) имеет полный контекст состояния. Он знает:
  - Точные балансы кошелька пользователя.
  - Какие токены и в каком объеме лежат в хранилище Vault.
  - Активную стратегию и какие DEX-программы в данный момент добавлены в `whitelist`.
- **Исполнение on-chain действий (Tool Calling)**: Чат не просто "разговаривает", но и может вызывать функционал приложения для реальных транзакций по желанию пользователя:
  - Подготовка и выполнение *Ребалансировки портфеля* под целевую стратегию (через серверный API `/api/rebalance`).
  - Экстренный выход: агент по команде "Конвертируй всё в USDC" переводит любые токены хранилища обратно в стейблкоины.
- **Умная обработка ошибок (Smart Fallback)**: Если для выполнения роута Jupiter не хватает разрешений в `whitelist`, AI сам ловит эту ошибку, выводит в чат недостающие ID программ и предлагает пользователю нажать одну кнопку для подписания транзакции `set_allowed_programs`. После аппрува выполнение продолжается.

---

## 🛠️ Development & Architecture

On-chain **Anchor** program `yield-vault` + **Node** agent API stub.

### Prerequisites

- Rust + `cargo`; use [rust-toolchain.toml](rust-toolchain.toml) (**1.89.x** for Anchor **0.32** IDL). Run `rustup toolchain install 1.89.0` if prompted; use `rustup override unset` in this repo if an old override hides the toolchain file.
- [Anchor](https://www.anchor-lang.com/docs/installation) CLI **0.32.1** — match [Anchor.toml](Anchor.toml) `anchor_version` (`avm install 0.32.1 && avm use 0.32.1`).

#### Solana / Agave CLI and `cargo-build-sbf` (recommended)

Older **platform-tools** ship **Cargo &lt; 1.85**, which cannot parse dependency manifests that declare **edition2024** (e.g. `blake3` 1.8.3). Install a current **Agave** release so **`cargo-build-sbf`** uses a new enough toolchain (e.g. platform-tools **v1.52** with **rustc 1.89**).

```bash
# Optional: remove stale install/cache (only if you are fixing a broken toolchain)
rm -rf ~/.cache/solana
rm -rf ~/.local/share/solana/install

# Install Agave / Solana CLI (stable)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Ensure PATH includes ~/.local/share/solana/install/active_release/bin (the installer prints this)

solana --version
cargo-build-sbf --version   # expect platform-tools v1.52+ / rustc 1.89+ in the output
```

Then align [Anchor.toml](Anchor.toml) `solana_version` with the version **`anchor build`** reports when it prints `✨ … initialized` (or set it to match `solana --version`). After upgrading CLI: `cargo clean` and `anchor build` from the repo root.

- Wallet keys for deployment
- Node.js 20+ (agent)

### Vault program (Rust/Anchor details)

- `initialize` — PDA vault, USDC ATA (owner = vault PDA), strategy, `agent`, `allowed_programs` whitelist.
- `set_allowed_programs` — **owner only**; replaces `Vault.allowed_programs` (max 16 program ids).
- `deposit` — SPL transfer from owner USDC ATA into vault USDC ATA.
- `withdraw` — SPL transfer from vault USDC ATA to owner USDC ATA; **owner only**; vault PDA signs via `invoke_signed`.
- `withdraw_spl` — same as `withdraw` but for **any mint**: transfers from a vault-owned token account (`authority` = vault PDA) to the owner’s account for that mint. Use when post-swap balances live in a non–deposit-mint ATA; the vault token account must already exist.
- `execute_swap_cpi` — `invoke_signed` into a **whitelisted** program id (first remaining account); remaining accounts follow that program's instruction layout.

Build:

```bash
anchor build
```

Match CLI to [Anchor.toml](Anchor.toml) (`anchor_version` / `solana_version`). Example with **avm**:

```bash
avm install 0.32.1
avm use 0.32.1
```

#### Deploying to devnet

1. **Cluster and SOL** — set devnet and ensure the deploy wallet has enough lamports (program rent is often **~1.8+ SOL** on devnet; keep **~2+ SOL** to be safe).

   ```bash
   solana config set --url devnet
   solana airdrop 2   # repeat or use https://faucet.solana.com if rate-limited
   solana balance
   ```

2. **Program id** — the address must match **`declare_id!`** in [`programs/yield-vault/src/lib.rs`](programs/yield-vault/src/lib.rs) and **`[programs.devnet]`** in [`Anchor.toml`](Anchor.toml). The pubkey comes from `target/deploy/yield_vault-keypair.json`.

   - New repo: run `anchor keys sync` after generating a keypair so source and config stay aligned.
   - If you deploy before syncing, you get **`DeclaredProgramIdMismatch`** when Anchor creates the on-chain IDL account. Fix: set `declare_id!` and `[programs.*]` to the **actual** program id, then `anchor build` and **`anchor deploy --provider.cluster devnet`** again (upgrade).

3. **Build and deploy**

   ```bash
   anchor build
   anchor deploy --provider.cluster devnet
   ```

4. **Success** — you should see the program confirmed, then IDL upload progress (`Step …/…`), then **`Idl account created: …`** and **`Deploy success`**.

**Localnet** — same idea: `anchor localnet` / `solana-test-validator`, then `anchor deploy` (or use the local cluster URL). Keep `declare_id!` in sync with `target/deploy/yield_vault-keypair.json`.

#### Client: devnet smoke test (TypeScript)

The [`client/`](client/) package runs **`initialize`** (strategy **Conservative**, empty **`allowed_programs`**), **`deposit`**, and **`withdraw`** on devnet. It uses two JSON keypairs: **owner** (signs transactions) and **agent** (only its pubkey is stored on-chain; no signature required for this flow).

**IDL file** — [`client/src/smoke.ts`](client/src/smoke.ts) loads [`target/idl/yield_vault.json`](target/idl/yield_vault.json). Run `anchor build` from the repo root **only when that file is missing** or after you **change the Rust program** (so the IDL matches on-chain behavior). If you already built once and did not delete `target/`, you can skip `anchor build` and go straight to `npm run smoke`.

#### Architecture: where the agent logic lives

> **All production agent logic (rebalance, convert-all, AI chat) runs inside `web/`** as Next.js API routes and server-side modules. There is **no separate agent service** to run.

Key paths inside `web/`:
- `web/src/app/api/chat/route.ts` — AI chat with portfolio context + chat-triggered actions
- `web/src/app/api/rebalance/route.ts` — HTTP endpoint for rebalance/convert-all
- `web/src/server/agent/runRebalance.ts` — rebalance orchestrator (called by both routes above)
- `web/src/server/agent/rebalance/engine.ts` — swap execution engine (Jupiter + vault CPI)

#### Agent vs owner (who signs, SOL, multiple vaults)

- **`execute_swap_cpi`** accepts `authority` signer if and only if `authority` is **`Vault.owner`** or **`Vault.agent`**. The vault PDA still “signs” token flows via `invoke_signed`.
- **Swap input tokens** (e.g. USDC) come from the **vault’s token ATAs**, not from the agent’s personal token accounts.
- **One agent key can drive many vaults**: each user has their own vault PDA (different `owner`).
- **`withdraw`** / **`withdraw_spl`** stay **owner-only**.

### Spec

See [what-we-build.md](what-we-build.md) for MVP architecture details.
