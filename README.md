# Yield AI — Solana Vault (MVP scaffold)

On-chain **Anchor** program `yield-vault` + **Node** agent stub.

## Prerequisites

- Rust + `cargo`; use [rust-toolchain.toml](rust-toolchain.toml) (**1.89.x** for Anchor **0.32** IDL). Run `rustup toolchain install 1.89.0` if prompted; use `rustup override unset` in this repo if an old override hides the toolchain file.
- [Anchor](https://www.anchor-lang.com/docs/installation) CLI **0.32.1** — match [Anchor.toml](Anchor.toml) `anchor_version` (`avm install 0.32.1 && avm use 0.32.1`).

### Solana / Agave CLI and `cargo-build-sbf` (recommended)

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

## Vault program

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

### Deploying to devnet

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

### After deploy (what to do next)

- **IDL and types** — `anchor build` writes [`target/idl/yield_vault.json`](target/idl/yield_vault.json) and client stubs under `target/types/`. You only need a fresh build when the **program or its interface changes** (or after `cargo clean` / deleting `target/`). If that file already exists, clients can use it as-is.
- **First on-chain step** — call **`initialize`** with a valid SPL **`usdc_mint`** (any mint on that cluster — e.g. devnet USDC or a mint from `spl-token create-token`), plus **`agent`**, **`strategy`**, and **`allowed_programs`**.
- **Then** — fund the owner ATA for that mint, **`deposit`**, test **`withdraw`**; **`execute_swap_cpi`** only after the target program id is in the whitelist and you pass correct remaining accounts.

### Client: devnet smoke test (TypeScript)

The [`client/`](client/) package runs **`initialize`** (strategy **Conservative**, empty **`allowed_programs`**), **`deposit`**, and **`withdraw`** on devnet. It uses two JSON keypairs: **owner** (signs transactions) and **agent** (only its pubkey is stored on-chain; no signature required for this flow).

**IDL file** — [`client/src/smoke.ts`](client/src/smoke.ts) loads [`target/idl/yield_vault.json`](target/idl/yield_vault.json). Run `anchor build` from the repo root **only when that file is missing** or after you **change the Rust program** (so the IDL matches on-chain behavior). If you already built once and did not delete `target/`, you can skip `anchor build` and go straight to `npm run smoke`.

**Plan**

1. **Dependencies** — `cd client && npm install`
2. **Keypairs** — `mkdir -p keys` and create `keys/owner.json` and `keys/agent.json` (`solana-keygen new …`). Print pubkeys with `solana-keygen pubkey keys/owner.json` (and `agent`).
3. **Devnet SOL on owner** — `solana config set --url devnet`, then `solana airdrop 1 <owner_pubkey>` or `solana transfer <owner_pubkey> 0.2 --allow-unfunded-recipient` from a funded wallet. Roughly **0.05+ SOL** is enough for this script.
4. **Env** — `cp .env.example .env`. Optionally set `MINT=<pubkey>` if you use an existing mint (e.g. devnet USDC) and fund the owner ATA yourself; otherwise leave `MINT` unset and the script will create a test mint and mint tokens to the owner.
5. **IDL** — if needed: `cd ..` (repo root) and `anchor build` to refresh `target/idl/yield_vault.json`.
6. **Run** — `cd client && npm run smoke`

The **agent** key is only required as a pubkey in `initialize`; keep `keys/agent.json` if you later sign **`execute_swap_cpi`**.

**BN / ESM note** — the client imports **`BN` from `bn.js`** (not from `@coral-xyz/anchor`), because some Node ESM builds do not expose `BN` as a named export from Anchor.

**What “good” looks like** — the script deposits **1_000_000** and withdraws **500_000** raw units (6 decimals ⇒ 1.0 and 0.5 tokens). If the vault already exists from a previous run, it prints `Vault PDA already initialized, skipping initialize.` After a successful run, **owner ATA** balance should reflect: `starting − 1_000_000 + 500_000`, and **vault ATA** should hold **500_000** raw units left from the net deposit.

Example devnet transactions (signatures from a successful smoke run):

- Deposit — [3Mh6me3PFB8i8g9vjxVAQqoeTi9RtjUfyth9jFmaQJuWHYcReKeCReFNDE8FmDxGAQRhcLzDioWpesok5aHEMGpJ](https://explorer.solana.com/tx/3Mh6me3PFB8i8g9vjxVAQqoeTi9RtjUfyth9jFmaQJuWHYcReKeCReFNDE8FmDxGAQRhcLzDioWpesok5aHEMGpJ?cluster=devnet)
- Withdraw — [5DNbi5UDoXMAdN7aeK7xjpiPgSchGkPDejFQc3wzx51u4iqpehhGngJuE6BvzEGxp9jvFx89Xo9p43avBHpa5T6f](https://explorer.solana.com/tx/5DNbi5UDoXMAdN7aeK7xjpiPgSchGkPDejFQc3wzx51u4iqpehhGngJuE6BvzEGxp9jvFx89Xo9p43avBHpa5T6f?cluster=devnet)

### Upgrading the deployed program (same address)

Yes. Solana **upgrades** a program **in place**: the **program id** stays the pubkey of `target/deploy/yield_vault-keypair.json`. After you change Rust, run `anchor build` (so `declare_id!` matches that pubkey), then `anchor deploy --provider.cluster devnet` again — the **upgrade authority** wallet (usually the same deployer key in `solana config`) signs, and bytecode at that address is replaced. User vault accounts and PDAs tied to that program id are unchanged; only logic/IDL updates require clients to use a matching IDL and, if you use on-chain IDL, `anchor deploy` will refresh it.

## Architecture: where the agent logic lives

> **All production agent logic (rebalance, convert-all, AI chat) runs inside `web/`** as Next.js API routes and server-side modules. There is **no separate agent service** to run.

Key paths inside `web/`:
- `web/src/app/api/chat/route.ts` — AI chat with portfolio context + chat-triggered actions
- `web/src/app/api/rebalance/route.ts` — HTTP endpoint for rebalance/convert-all
- `web/src/server/agent/runRebalance.ts` — rebalance orchestrator (called by both routes above)
- `web/src/server/agent/rebalance/engine.ts` — swap execution engine (Jupiter + vault CPI)

## Agent (standalone CLI — for debugging only)

> ⚠️ The `agent/` folder is a **standalone CLI/debug tool**, not the production agent. It was used during early development to test Jupiter swap integration and vault CPI wiring. You do **not** need to run it for the web app to function.

```bash
cd agent
copy .env.example .env
# set JUPITER_API_KEY from https://portal.jup.ag/
npm start
```

Uses Jupiter REST (`api.jup.ag`) with `x-api-key`. Rebalance allocation logic and vault CPI wiring are follow-up work.

### Jupiter integration (next step)

**Jupiter does not provide a devnet-equivalent** for swap routing and liquidity comparable to mainnet. Expect to validate **`execute_swap_cpi`** (whitelist + remaining accounts from a Jupiter-built instruction) on **mainnet-beta** with **small amounts**, **`JUPITER_API_KEY`**, preflight/simulation, and a dedicated RPC. Custody flows (`initialize`, `deposit`, `withdraw`) can stay on **devnet** for cheap iteration. More context: [what-we-build.md](what-we-build.md) (section **Clusters**).

#### Swap via CPI (agent CLI)

The agent contains a simple CLI that:

- calls `GET /swap/v2/build` with `taker = vault PDA`
- prints the **unique program ids** you must include in `Vault.allowed_programs`
- wraps Jupiter's `setupInstructions` / `swapInstruction` / `cleanupInstruction` as **multiple** calls to `execute_swap_cpi` in one v0 transaction
- simulates the transaction to estimate compute units (then rebuilds with ~1.2x buffer)

Use a **mainnet-beta** `RPC_URL` when `RUN_SWAP_CLI=1`: Jupiter `/build` returns mainnet routes and address lookup tables; a devnet RPC will fail with missing ALT / cluster mismatch.

Enable it by setting `RUN_SWAP_CLI=1` in `agent/.env`. See [`agent/.env.example`](agent/.env.example) for required env vars.

#### Agent vs owner (who signs, SOL, multiple vaults)

- **`execute_swap_cpi`** accepts `authority` signer if and only if `authority` is **`Vault.owner`** or **`Vault.agent`** (see [`programs/yield-vault/src/lib.rs`](programs/yield-vault/src/lib.rs)). The vault PDA still “signs” token flows via `invoke_signed` inside the program.
- **Outer transaction fee payer** is whoever you pass as **`AUTHORITY_KEYPAIR`** in `agent/.env` (that key must match `owner` or `agent` on-chain for the vault you target). Fund **that** wallet with **SOL** on the cluster you use (mainnet-beta for Jupiter `/build`): network fees, and sometimes **rent** for new accounts when Jupiter’s `/build` uses `payer` = that pubkey.
- **Swap input tokens** (e.g. USDC) come from the **vault’s token ATAs**, not from the agent’s personal token accounts, as long as the route spends from vault balances.
- **Owner does not have to sign** a swap tx when the **agent** key is `Vault.agent` and you set `AUTHORITY_KEYPAIR` to the agent keypair; the owner is still the logical “customer” because `Vault` PDA is derived from **`["vault", owner_pubkey]`** (`VAULT_OWNER_PUBKEY` in env).
- **One agent key can drive many vaults**: each user has their own vault PDA (different `owner`). Use the same agent key as `AUTHORITY_KEYPAIR` and change **`VAULT_OWNER_PUBKEY`** per user; each vault must have been **`initialize`d** with **`agent`** equal to that agent’s pubkey.
- **`withdraw`** / **`withdraw_spl`** stay **owner-only**; the agent cannot pull user tokens to the owner’s wallet unless you add a different instruction later.

## Spec

See [what-we-build.md](what-we-build.md).
