# Plan: Decouple runtime read APIs from Strapi (direct Postgres) + security hardening

## Context

The site's dynamic APIs (search, offer-redeem resolver, redirects, plus rating/feedback/unique-claim writes) currently proxy through the ISR gateway to Strapi. The user's driving concern is that **the website must not be compromisable**, with performance and ease of deployment as co-goals. Exploration confirmed Strapi's API is already firewalled off the public internet (nginx 403 on `/api/`, loopback+VPC-only port bindings, DO Cloud Firewall) — so the remaining wins are: removing Strapi from the runtime read path (availability + perf under publish storms, solves the request-path half of P2/P3), removing the `ISR_ADMIN_SECRET` bearer from the runtime path, and closing the two audit items C-1 (missing indexes) and H-11 (one secret spanning three trust domains).

**This migration is already architected in-repo**: `cguru-ui/PERFORMANCE-HA-PLAN.md` §7 (Phase 3). This plan implements it, extends it with the redirect-map read, and folds in the C-1/H-11 hardening.

**User decisions (confirmed):**
- **Reads only for now**: search, offer-redeem resolver, redirect map go direct-to-DB. Writes (rating, offer-feedback, `POST /unique-coupon/redeem` claim, contact, header-notification) keep proxying to Strapi over the VPC — acceptable because Strapi is not internet-reachable and hardening lands. Writes port is a documented future phase.
- **Separate `data-api` container** (per §7): the public-facing gateway never holds DB credentials; crash isolation; the 22-connection PG budget already reserves 5 for it (admin@5 + render@5 + data-api@5 = 15).
- **Hardening included**: C-1 indexes + H-11 secret split.

**Constraints** (from memory/user prefs): I implement + typecheck; the user runs all DB commands/migrations himself — the plan supplies exact SQL/commands. Never read `.env*` files.

## Architecture

```
Browser → CloudFront → gateway :3010 (only public origin)
   search / redeem-resolver / redirect-map → data-api :3020 (127.0.0.1, read-only PG role, pool max 5)
   rating / feedback / unique-claim / contact / notification → Strapi :1337 over VPC (unchanged)
Astro SSR → strapi-render :1338 (unchanged — render-path decoupling is out of scope)
```

- New Fastify service `cguru-ui/services/data-api` (name: `data-api`; update the `search-redeem` references in PERFORMANCE-HA-PLAN.md §7/§8.2 to this name). Own Dockerfile, joins `compose.isr.yml` on the UI droplet, binds `127.0.0.1:3020` only.
- Gateway keeps ALL existing machinery (LRU/admission/coalescing for search, Redis cache + stampede lock for redeem, in-memory redirect map w/ 60s TTL). Only the upstream seams change:
  - `fetchUpstreamSearch` — `isr-gateway/src/search-route.ts:918`
  - `resolveFromStrapi` — `isr-gateway/src/offer-redeem-route.ts:652`
  - `RedirectService` origin — `isr-gateway/src/server.ts:107-113` (currently Astro origin)
- Per-route upstream selector env flags with **shadow mode** for rollback safety (PERFORMANCE-HA-PLAN §11 verification protocol): `strapi | data-api | shadow` (shadow = serve Strapi result, also call data-api, log structured diff).

## Phase A — Prerequisites (cguruadmin + operator)

### A1. C-1 indexes (audit `AUDIT-2026-07-29.md:345`, "Do first")
New reconciler in `cguruadmin/database/` following the existing `runOptionalDdl` graceful-degradation pattern (`database/search-index-migration.js:27-77` — savepoints, 42501/55P03 handling, `CREATE INDEX CONCURRENTLY` outside txn with `lock_timeout`/`statement_timeout` guards). Indexes on `coupons` and `deals`:
- partial `(published_on DESC, published_at DESC) WHERE content_status = 'published'`
- `(content_status, expires_at)`
- `(content_status, scheduled_at)`
- functional `LOWER(slug)` on `stores/brands/categories/banks` per audit recommendation
Wire into the ordered post-schema bootstrap reconciliation beside
`reconcileSearchIndexesAfterSchemaSync` in
[`src/lifecycles/bootstrap-reconciliation.ts`](../src/lifecycles/bootstrap-reconciliation.ts).

### A2. Operator actions (user runs; already documented as pending in PERFORMANCE-HA-PLAN §0.1)
- `ALTER DATABASE ... SET jit = off` + off-peak `VACUUM (ANALYZE)` (search-504 leftovers). Note: the query-shape fix is the real guard; this is belt-and-braces.
- Set DB-level default `statement_timeout` per §0 if not done.

### A3. Read-only Postgres role (user runs; plan supplies exact SQL)
```sql
CREATE ROLE cguru_data_ro LOGIN PASSWORD '<generate>';
GRANT CONNECT ON DATABASE <db> TO cguru_data_ro;
GRANT USAGE ON SCHEMA public TO cguru_data_ro;
GRANT SELECT ON stores, brands, categories, banks, coupons, deals, redirects,
  unique_coupon_pools, files, files_related_mph,
  coupons_stores_lnk, coupons_brands_lnk, coupons_categories_lnk, coupons_banks_lnk,
  deals_stores_lnk, deals_brands_lnk, deals_categories_lnk, deals_banks_lnk,
  coupons_unique_coupon_pool_lnk, deals_unique_coupon_pool_lnk
TO cguru_data_ro;
ALTER ROLE cguru_data_ro SET statement_timeout = '5s';
```
**Deliberately NO grant on `unique_codes`** (coupon codes are the crown jewels — resolver only needs pool name/documentId; `code` is redacted for unique-type offers anyway), and none on `admin_users`, `strapi_api_tokens`, `up_users`, `isr_outbox`, vote tables. A compromised data-api can read only already-public catalog data.

## Phase B — `data-api` service (new: `cguru-ui/services/data-api/`)

Scaffold mirrors `isr-gateway` conventions (Fastify 5, pino, tsx/tsc, vitest-style tests). Deps: `fastify`, `pg`, `pino`. Pool: max 5 (`DATABASE_POOL_MAX` env, deliberate per §8.2), TLS to DO managed PG (CA via env path, mirror `cguruadmin/config/database.ts:5-32` handling), `statement_timeout` also set at pool level.

### B1. `GET /search` — port of Strapi search (the hard one)
- Copy `cguruadmin/src/api/search/services/search-sql.ts` verbatim — it's a pure `{sql, bindings}` builder (entity + offer ranked/count queries). **Load-bearing details that must not drift**: `translate()` ASCII fold (the 11 GIN trgm indexes are built on that exact expression — `lower()` loses them all), `ESCAPE '\'` bound-param LIKE patterns, tier ranking via `LEAST()`, tie-break folded-label + `document_id` both `COLLATE "C"`, UNION ALL membership arms (the JIT fix — never OR-of-EXISTS).
- Port needle derivation: `queryVariants`/`filterNeedles` (`search.ts:341-371`), `slugNeedle` + `GENERIC_SLUG_TERMS` (`search.ts:541-558`), NFKC request validation (`parseRequest`, `search.ts:177-230`).
- Reimplement hydration in SQL (today it goes through Strapi's document service): fetch ranked rows by id, join media via `files_related_mph` (`related_id`,`related_type`,`field`,`order`) → `files` (incl. `formats` JSON with `*_avif` twins and custom `background_colour` column), replicate `mapEntity`/`mapOffer`/`mapMedia` (`search.ts:264-535`) including `codeMode` and `safeEntityHref`. Re-apply the visibility predicate at hydration (row can expire between rank and hydrate — `search.ts:800-806`).
- Response envelope must satisfy the gateway's strict validator (`search-route.ts:371-480`): byte-identical query echo, `pageCount === min(ceil(total/pageSize), 20)`, `hasMore === page < pageCount`, `items.length <= total`, preview windows 7 entities + 3 offers with backfill-2 semantics (`search.ts:26-34, 1375-1391`).

### B2. `GET /offer-redeem/:entityType/:documentId` — resolver port
Single SQL read against `coupons|deals` + `_lnk` joins for owner name (stores→brands→banks precedence per `custom.ts:754-824`) + pool relation for `uniqueCouponPool {documentId, name}`. Visibility: replicate `computeContentStatus` semantics — `content_status = 'published'` and date windows (`cguruadmin/src/utils/content-status.ts:11-43`); note draft-and-publish is OFF, `published_at` is always set, visibility is data not lifecycle. Redact `code` → null when `coupon_type = 'unique'` (`redactUniqueOfferCode`, `custom.ts:310-315`). Response shape = what `normalizeRedeemOffer` (`offer-redeem-route.ts:197-273`) consumes. No bearer needed (loopback-only), which retires the `ISR_ADMIN_SECRET`-as-resolver-token usage.

### B3. `GET /redirect-map.json` — redirect map direct from DB
`SELECT "from", "to", status_code FROM redirects WHERE active = true ORDER BY "from" ASC` (quote reserved words), emit the gateway wire format `{version: 2, rules: [{key, to, status}]}` (`redirect-map.ts:153-206`, max 10k rules). Port the key-folding from `redirectKey()` in `cguru-ui/src/features/routing/api/get-redirects.ts:152` **byte-identically** (gateway's `foldRequestKey` must keep matching). Return 503 on DB failure so the gateway keeps serving its stale map (same contract as the Astro endpoint today).

### B4. Guardrails (§7.3 — mandatory)
- Startup schema probe: verify required tables/columns/indexes exist → else fail `/readyz` loudly. `/livez` stays trivial.
- CI integration tests against a real Postgres loaded with the Strapi schema (cguruadmin CI already spins `postgres:16-alpine` — reuse the approach; seed via Strapi schema dump or migration replay).
- Contract tests: every search response fixture must pass the gateway's `isCurrentSearchPayload` validator; resolver fixtures must pass `normalizeRedeemOffer`.
- Document in both repos' AGENTS.md: Strapi v5 upgrades are now a two-repo event (schema coupling).

## Phase C — Gateway changes (`cguru-ui/isr-gateway/`)

### C1. Upstream selector + shadow mode
- `gateway-config.ts`: add `DATA_API_URL` (default `http://127.0.0.1:3020`) and per-route flags `SEARCH_UPSTREAM` / `REDEEM_UPSTREAM` / `REDIRECT_MAP_UPSTREAM` ∈ `strapi|data-api|shadow` (default `strapi` until cutover).
- Swap at the three seams only; all caching/limiting/validation machinery untouched. Shadow mode: serve the Strapi result, fire-and-forget the data-api call, log a structured diff (path, mismatch fields, latency pair) — never affects the response.
- Redirect seam: `RedirectService` gets the map origin from config instead of hardcoded `astroOrigin`.

### C2. H-11 secret split (audit `AUDIT-2026-07-29.md:1209`)
- Retire the resolver-bearer usage of `ISR_ADMIN_SECRET` (`server.ts:212` `strapiToken: config.adminSecret`) once `REDEEM_UPSTREAM=data-api`.
- Split remaining domains: `ISR_GATEWAY_ADMIN_SECRET` (Strapi outbox → gateway `/revalidate` + `/internal/isr/*`) distinct from Strapi's own deploy/search-status secret. Both repos' env examples updated; cguruadmin outbox runtime (`src/isr-outbox/runtime.ts:12-35`) reads the new var name (keep old name as fallback for one release).
- Bind the control plane to a second Fastify listener on the VPC private IP only (audit recommendation): `/revalidate` and `/internal/isr/*` move off the public listener so they are unreachable via CloudFront. Add a failed-bearer rate-limit bucket as defense in depth.

## Phase D — Deployment & cutover

### D1. Ease-of-deploy integration (follows existing patterns exactly)
- `release-deploy.yml`: build/push 4th cguru-ui image `cguru-data-api` (repo-root context if it shares `packages/`, else service dir); add data-api tests + typecheck to the quality gate.
- `deploy/compose.isr.yml`: new `data-api` service — `127.0.0.1:3020` publish only, `restart: unless-stopped`, `init`, `no-new-privileges`, `user 1001:1001`, log caps, healthcheck `GET /readyz`. Start order in `deploy.sh`: redis → ssr → **data-api** → gateway + worker (existing rollback/backup logic covers the new files automatically since it restores compose + env wholesale).
- `deploy/env/data-api.env.example`: `DATABASE_URL` (role `cguru_data_ro`), `DATABASE_SSL_*`, `DATABASE_POOL_MAX=5`, `PORT=3020`. Host-owned `.env` chmod 600 like the others.
- `gateway.env.example`: add `DATA_API_URL` + the three upstream flags + renamed admin secret.

### D2. Rollout sequence
1. Deploy cguruadmin (A1 indexes) → user verifies indexes exist (`\di+` / `pg_indexes`).
2. User runs A2 operator actions + A3 role creation.
3. Deploy cguru-ui with data-api in **shadow** for search + redeem + redirect-map. Watch diffs for a few days of real traffic.
4. Flip flags to `data-api` one route at a time (search → redirect-map → redeem). `strapi` flag value remains as instant rollback for ≥1 release.
5. After stable cutover: remove resolver bearer wiring; Strapi's `/api/offer-redeem` route can be disabled; network rules unchanged (gateway still needs Strapi :1337 for the write proxies).

## Out of scope (documented future phases)
- **Writes port** (rating incremental-average + outbox invalidation row, feedback, unique-claim `SKIP LOCKED` SQL) — all already raw SQL in Strapi, mechanical to move later; needs a second read-write role scoped to vote tables + `unique_codes` claim columns.
- **Render-path decoupling** — Astro SSR still reads Strapi (:1338) for page regeneration (26 modules via `strapi-client.ts`); the site is not fully Strapi-independent until that moves.
- Redis-backed (cross-restart) search cache — noted opportunity, not needed now.

## Verification
- **Shadow diff**: structured diff logs empty (or explained) across N days for all three routes before each flag flip; latency pairs show data-api p95 < Strapi path p95.
- **Contract**: gateway validator never 502s against data-api responses in shadow; `X-ISR` headers unchanged post-cutover.
- **Indexes**: `EXPLAIN (ANALYZE)` on offer search + resolver queries shows index scans (no seq scan on `stores`/`coupons`/`deals`); `pg_stat_user_tables` seq-scan counters flatten.
- **Least privilege**: as `cguru_data_ro`, `SELECT * FROM unique_codes` and `SELECT * FROM admin_users` must fail with permission denied (user runs).
- **Schema probe drill**: point data-api at a DB missing a column → `/readyz` fails, compose marks unhealthy, deploy aborts.
- **Network posture**: `ss -tlnp` on UI droplet shows :3020 only on `127.0.0.1`; from outside, `nc -zv <public-ip> 3020` fails; `/revalidate` via the public origin returns 404/unreachable after C2, still works from CMS droplet over VPC.
- **Deploy drill**: full `deploy.sh` run + forced-failure rollback with the 6th container present; PG connections graph stays ≤ ~15 of 22.
- **Perf**: `curl -w '%{time_total}'` per route before/after from the droplet; one week p50/p95 comparison (per PERFORMANCE-HA-PLAN §11); search under a publish storm no longer degrades (P3 request-path relief).
