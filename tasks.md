## Tasks

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

