## Tasks

### AI chat MVP: strategy discussion + on-chain actions (hackathon priority)

- **Phase 1: Chat with portfolio context (current snapshot only)**
  - Replace the UI chat placeholder with a working chat component.
  - Add `/api/chat` in `web/` backed by OpenRouter (streaming + tool calling).
  - Provide the chat with a structured snapshot:
    - wallet holdings (SPL + Token-2022 + prices)
    - vault holdings (vault PDA balances + prices)
    - vault state: strategy + allowed programs

- **Phase 1: Chat-triggered actions (explicit user intent only)**
  - From the chat, trigger existing execution flows:
    - rebalance via `POST /api/rebalance`
    - convert-all-to-USDC via `POST /api/rebalance` with `action="convert_all"`
  - Handle `needs_whitelist` gracefully:
    - surface missing program IDs in the chat UI
    - let the vault owner sign a one-time `set_allowed_programs` transaction
    - retry the requested action after approval
  - Add guardrails: never run execution tools without a clear confirmation/click.

- **Phase 2: Add historical context (after Phase 1 works)**
  - Add `vault-history` summary to the chat context (deposits/withdrawals + net deposited + basic PnL).

- **Deferred (only if time): automation**
  - Scheduled/hourly rebalancing, background agents, triggers, cron jobs.

### APR display for USDY, Onyc, jitoSOL

- **Define requirements**
  - Decide where APR should be shown: Vault card, asset list rows, deposit card, or all of them.
  - Decide formatting: APR %, APY %, tooltip/source link, and data freshness (e.g. last updated timestamp).

- **Pick reliable APR data sources**
  - **USDY (Ondo)**: identify official/public endpoints or partner data that provides current yield (APR/APY) and update cadence; document fallback if unavailable.
  - **jitoSOL (Jito)**: find canonical staking yield source (e.g. on-chain stats, official API, or trusted indexer) and define how APR is computed (7d/30d, net of fees, etc.).
  - **Onyc**: clarify what “Onyc” refers to (token/project) and find an authoritative yield source (or define “N/A” behavior if it is not a yield-bearing asset).

- **Backend/API plumbing**
  - Add a server-side fetcher that normalizes all yields into a common shape (e.g. `{ symbol, apr, source, updatedAt }`).
  - Add/extend a Next.js API route to return yields (or piggyback on existing vault/asset routes) with caching and rate-limit friendly behavior.
  - Add error handling + fallback values to avoid breaking the UI when a provider is down.

- **Frontend integration**
  - Extend portfolio/vault asset models to carry `apr` and `aprSource`.
  - Display APR next to the asset name or balance for `USDY`, `Onyc`, `jitoSOL`.
  - Add a tooltip/popover with: “APR”, “Source”, and “Last updated”.

- **Testing & verification**
  - Add a lightweight unit test for normalization/calculation (where applicable).
  - Manual check in dev: APR renders, loading state, and graceful “N/A” on provider failure.

### Token price charts (strategy tokens) via TradingView

- **Define chart scope**
  - Strategy tokens list source of truth (where we derive the token symbols/mints used by the strategy).
  - Chart timeframe defaults (1D/1W/1M) and whether we allow switching.

- **TradingView integration**
  - Decide approach: TradingView widget/embed vs custom chart consuming TradingView datafeed.
  - Map each strategy token to a TradingView symbol (including network/venue specifics if needed).
  - Handle “no symbol available” gracefully (placeholder + link).

- **UI implementation**
  - Add a chart section to the vault/strategy view and/or per-asset row detail.
  - Loading + error states; avoid layout shift.

- **Verification**
  - Manual: charts render for all strategy tokens; no console errors.

### Vault allocation pie chart

- **Data**
  - Define allocation source: current vault balances by asset (and pricing method used to convert to USD value).
  - Define which assets are included/excluded (dust threshold, unknown assets bucket).

- **UI**
  - Add pie/donut chart component + legend (asset, %, value).
  - Hover/tooltip interactions and responsive layout.

- **Verification**
  - Manual: allocation chart matches the numeric allocation table for the same vault snapshot.

