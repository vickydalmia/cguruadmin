# Public API

The contract the ISR gateway and the Astro frontend code against. Everything
here is `auth: false` (anonymous) unless the table says otherwise; core Strapi
`find`/`findOne` routes for Coupon and Deal stay **disabled**, so these custom
routes are the entire public read surface for offers.

Guards are configured per route, not globally. `global::rate-limit` is a
per-IP sliding window on the koa-resolved client IP (honours `TRUST_PROXY`);
`global::cache` is a per-process TTL response cache that sets `X-Cache:
HIT`/`MISS` and is purged immediately whenever content changes, so the TTL is a
ceiling on staleness, not a fixed delay.

| Route | Auth | Rate limit | Cache |
|---|---|---|---|
| `GET /api/search` | anonymous | 120 / 60s | 30s |
| `GET /api/search/status` | **bearer secret** (`global::search-status-auth`) | — | `Cache-Control: private, no-store` |
| `GET /api/directories/:kind` | anonymous | 120 / 60s | 60s, keyed by path |
| `GET /api/homepage-full` | anonymous | 60 / 60s | 60s |
| `GET /api/deal-of-the-day-full` | anonymous | 60 / 60s | 60s, keyed by path |
| `GET /api/entity-deal-pages/:dealSlug` | anonymous | 60 / 60s | 60s |
| `GET /api/entity-deal-page-routes` | anonymous | 60 / 60s | 60s |
| `GET /entity-deal-page/pages` | **Super Admin session** | — | none |
| `PATCH /entity-deal-page/pages/:kind/:documentId` | **Super Admin session** | — | none |
| `GET /api/site-chrome` | anonymous | — | 300s |
| `GET /api/public-route-metadata` | anonymous | 60 / 60s | 60s, keyed by path |
| `GET /api/sitemap-entities` | anonymous | 60 / 60s | 60s, keyed by path |
| `GET /api/redirects` | anonymous (core `find`, public role) | 60 / 60s | 60s |
| `GET /api/offers`, `GET /api/deals` | anonymous | 60 / 60s | 60s |
| `GET /api/coupon-page/:id` | anonymous | 60 / 60s | 60s |
| `GET /api/{stores\|brands\|categories\|banks}/:slug/{coupons\|deals}` | anonymous | 60 / 60s | 60s |
| `GET /api/{stores\|brands\|categories\|banks}/:slug/related-stores` | anonymous | — | 60s |
| `POST /api/{stores\|brands\|categories\|banks}/:slug/rating` | anonymous | 5 / 60s | none (never cached) |
| `POST /api/offer-feedback/:entityType/:documentId` | anonymous | 10 / 60s | none (never cached) |
| `GET /api/offer-redeem/:entityType/:documentId` | **bearer secret** | — | none |
| `POST /unique-coupon/redeem` | anonymous | 30 / 60s (plugin backstop; the ISR gateway's 10 / 60s binds first) | none |
| `GET /unique-coupon/stats/:poolDocumentId` | **admin session** | — | none |
| `POST /unique-coupon/upload` | **admin session** | — | none |

The `keyByPath` entries ignore the query string entirely, so `?nonce=1`,
`?nonce=2`, … all share one cache entry and cannot be used to force repeated
full-catalog scans.

Route definitions: [`src/api/search/routes/search.ts`](../src/api/search/routes/search.ts),
[`src/api/directory/routes/directory.ts`](../src/api/directory/routes/directory.ts),
[`src/api/homepage/routes/custom.ts`](../src/api/homepage/routes/custom.ts),
[`src/api/deal-of-the-day-page/routes/custom.ts`](../src/api/deal-of-the-day-page/routes/custom.ts),
[`src/api/entity-deal-page/routes/entity-deal-page.ts`](../src/api/entity-deal-page/routes/entity-deal-page.ts),
[`src/api/coupon/routes/custom.ts`](../src/api/coupon/routes/custom.ts),
[`src/api/store/routes/custom.ts`](../src/api/store/routes/custom.ts),
[`src/api/redirect/routes/redirect.ts`](../src/api/redirect/routes/redirect.ts),
[`src/plugins/unique-coupon/server/src/routes/index.ts`](../src/plugins/unique-coupon/server/src/routes/index.ts).

---

## Search

`GET /api/search` — implemented in
[`src/api/search/services/search.ts`](../src/api/search/services/search.ts).

### Parameters

Only these five keys are accepted. **Any unknown key is a 400** (`Unsupported
search parameter`) — this is a closed allowlist, not a filter.

| Param | Values | Notes |
|---|---|---|
| `query` | 2–80 characters | Required. NFKC-normalized, trimmed, internal whitespace collapsed; length is counted in code points. Out of range is a 400 |
| `mode` | `preview` \| `group` | Defaults to `preview`. Any other value is a 400 |
| `group` | one of the six group keys | Presence of a valid `group` implies `mode=group`. `mode=group` without a valid group, or an unrecognised group value, is a 400 (`A valid search group is required`) |
| `page` | integer ≥ 1 | Clamped to 20. Non-numeric input falls back to 1 |
| `pageSize` | integer ≥ 1 | Default 20, clamped to 50. Non-numeric input falls back to the default |

### Groups

There are exactly **six** result groups: `stores`, `brands`, `categories`,
`banks`, `coupons`, `deals`.

> **`insights` is not a search group.** It is not a compatibility alias either:
> `group=insights` is rejected as an invalid group, and no `insights` key is
> emitted in `results`, `totals` or `hasMore`. The ISR gateway rejects any
> upstream payload that still carries one, so this is a hard cross-repository
> API contract. Coordinated release and rollback order are in the canonical
> [deployment guide](https://github.com/vickydalmia/cguru-ui/blob/main/docs/deployment.md).

### Response envelope

Both modes return the same envelope; every group key is always present, so
consumers never need existence checks.

```json
{
  "query": "flipkart",
  "suggestions": [{ "id": "suggestion-1", "label": "Flipkart coupons", "query": "Flipkart coupons" }],
  "stores": [],
  "brands": [],
  "categories": [],
  "banks": [],
  "coupons": [],
  "deals": [],
  "totals":  { "stores": 0, "brands": 0, "categories": 0, "banks": 0, "coupons": 0, "deals": 0 },
  "hasMore": { "stores": false, "brands": false, "categories": false, "banks": false, "coupons": false, "deals": false },
  "pagination": null,
  "partialSources": []
}
```

- **`totals`** — full match counts for the query, independent of the page
  window. In `preview` all six are populated; in `group` mode only the
  requested group's total is (requesting `coupons` or `deals` populates both
  offer totals, because the two counts are fetched together).
- **`hasMore`** — in `preview`, true when a group's total exceeds what the
  preview window shows (7 for entity groups, 3 for coupons/deals). In `group`
  mode it is `page < pageCount` for the requested group only.
- **`pagination`** — `null` in `preview`. In `group` mode it is
  `{ group, page, pageSize, pageCount, total }`, with `pageCount` clamped to
  20 pages so `hasMore` goes false at the clamp instead of advertising
  unreachable pages.
- **`suggestions`** — preview only; up to four derived query strings seeded
  from the best-matching entity name, deduplicated. `group` mode leaves it
  empty.
- **`partialSources`** — always an empty array today. It is a reserved slot in
  the envelope for degraded-source reporting; consumers should tolerate
  entries but must not depend on any.

### Result items

Entity and offer hits share one item shape, so a single card component renders
any group:

`id`, `name`, `link`, `type` (`store` | `brand` | `category` | `bank` |
`coupon` | `deal`), `subtitle`, `storeName`, `media`, `price`,
`originalPrice`, `discount`. Deal hits additionally carry `expiresAt` and
`owner`. Items whose name or link cannot be sanitized are dropped rather than
emitted half-formed, and preview windows over-fetch a small margin so the
displayed list still fills.

`link` is either a validated absolute `http(s)` affiliate URL or an internal
`/slug/` path; nothing else is emitted. Note that entity slugs may contain
nested segments (`shopping-coupon/flipkart`), so build links from the returned
value rather than assuming one path segment.

`media` is `null` when the record has no usable image, otherwise
`{ src, srcset, avifSrcset, width, height, alt }`. `srcset` carries the
universally-decodable WebP/fallback ladder; `avifSrcset` is a separate ladder
for a `<source type="image/avif">` and is **`null` unless the AVIF ladder's
widest candidate is at least as wide as the fallback ladder's**. An AVIF
`<source>` shadows the entire fallback srcset for capable browsers, so a twin
ladder whose top rung the encoder's size guard dropped would commit them to
upscaling — the coverage rule prevents that. The frontend applies the same
rule under the name `avifLadderCoversFallback`.

### Modes

- **`preview`** — one request fills the whole overlay: all four entity groups
  (7 each) plus coupons and deals (3 each), with totals for all six.
- **`group`** — one group, `LIMIT`/`OFFSET` paged by `page`/`pageSize`.

Ranking, the ranked-SQL vs query-engine decision, and the trigram indexes are
operator concerns — see [search-operations.md](./search-operations.md).

### `GET /api/search/status`

Machine-only operational diagnostics — not part of the public surface. Requires
`Authorization: Bearer $ISR_ADMIN_SECRET` (the `global::search-status-auth`
policy, which fails closed when the secret is unset) and is deliberately
uncached (`Cache-Control: private, no-store`). Returns
`{ mode, pgTrgmAvailable, missingExpectedIndexes,
invalidExpectedIndexes }`. Documented in
[search-operations.md](./search-operations.md).

---

## Directory

`GET /api/directories/:kind` where `kind` is `store`, `brand`, `category` or
`bank` (singular). Anything else is a 400. Implemented in
[`src/api/directory/services/directory.ts`](../src/api/directory/services/directory.ts).

Returns the full A–Z catalog for one entity kind in a single response:

```json
{
  "kind": "store",
  "generatedAt": "2026-07-20T00:00:00.000Z",
  "totals": { "entityCount": 0, "couponCount": 0, "productDealCount": 0 },
  "popular": [],
  "items": [{ "documentId": "...", "name": "...", "slug": "...", "couponCount": 0, "productDealCount": 0 }]
}
```

`items` is every entity of that kind sorted by name (ties broken by
`documentId` for stability), each annotated with its live coupon and product-deal
counts. `popular` is the top 8 entities that have at least one live offer,
hydrated with media. Only published, unexpired offers are counted.

## Page aggregates

- `GET /api/homepage-full` — the entire homepage single type with its component
  tree deeply populated, returned as `{ data }`. Dead offers are dropped from
  curated lists, Top Deals are backfilled, lists are capped to their schema
  maxima, and offer counts are attached. 404 when the homepage has never been
  seeded.
- `GET /api/deal-of-the-day-full` — the same treatment for the Deal of the Day
  single type.
- `GET /api/site-chrome` — `{ menu, footer, global }` in one call, each `null`
  if that single type is unseeded. This is the header/footer payload; its 300s
  cache is the longest on the public surface because chrome changes rarely.

### Generated entity Product Deal pages

For the complete operator and implementation workflow, see
[`entity-deal-pages.md`](./entity-deal-pages.md).

Every Store, Brand, Category, and Bank owns a deterministic generated
permalink: the shared slugification of its current name plus `-deals`, for
example the name `Mobile Phones` produces `/mobile-phones-deals/` regardless
of the entity page slug. `GET
/api/entity-deal-pages/mobile-phones-deals?page=1&pageSize=50`
resolves the owning entity across all four types and returns only actionable
Deal-schema records; Coupon records never enter this response.

The response is `{ data: { route, entity, seo, deals, pagination } }`.
`seo.noIndex` defaults to `true`. An explicit Super Admin opt-in only becomes
effectively indexable when the page has at least one live actionable deal, its
canonical is the generated URL itself, and no entity or redirect owns that
route. `seo.blockers` reports any failed condition. This keeps empty or
conflicting pages reachable for the future template while forcing `noindex`.

`GET /api/entity-deal-page-routes` returns the minimal generated route
inventory used by Astro and the ISR gateway:
`{ entityType, documentId, id, path, updatedAt, noIndex }`. `updatedAt` is the
newer of the entity row and its latest live Deal update. The route is anonymous,
rate-limited, and cached for 60 seconds.

The dormant administration contract is:

- `GET /entity-deal-page/pages` lists all generated permalinks and updates
  automatically as entities are added. It accepts `kind`, `search`,
  `indexState` (`enabled`, `disabled`, or `blocked`), `page`, and `pageSize`.
- `PATCH /entity-deal-page/pages/:kind/:documentId` accepts
  `{ "data": { "entityDealPageSeo": { ... } } }` and only updates the hidden
  Deal-page SEO component.

Both administration routes require an authenticated Strapi Super Admin. The
component is intentionally hidden from each entity edit form until a dedicated
settings screen is designed. Public pages remain `noindex` unless the dormant
Super Admin contract explicitly enables one and every SEO blocker passes.

## Route metadata and redirects

- `GET /api/public-route-metadata` — `{ data }`, a flat list of
  `{ path, updatedAt, noIndex }` entries for the managed single-type pages plus
  every active job's `/careers/:slug/` route. The ISR gateway consumes it to
  drive sitemap/revalidation and to honour per-route `noIndex`. Rate-limited
  60/60s and cached 60s keyed by path (the query string is ignored).
- `GET /api/sitemap-entities` — `{ data }`, one row per store / brand /
  category / bank: `{ kind, documentId, id, slug, updatedAt, offersUpdatedAt?,
  imageUrl? }`. Decoration for the frontend's sharded sitemap, and nothing
  else — route *membership* still comes from the collections themselves via
  `get-flat-routes.ts`, so a failure here degrades the sitemap's `lastmod`
  precision without dropping any URL.
  - `offersUpdatedAt` is `MAX(updated_at)` over the entity's **visible**
    coupons and deals (published, not past `expiresAt`), computed as one
    grouped join per `coupons_*_lnk` / `deals_*_lnk` table. An entity page's
    content *is* its offers, so the entity row's own `updatedAt` alone
    under-reports badly.
  - Deliberately **not** an OR-of-EXISTS: that shape inflated planner costs on
    this database badly enough to trip JIT compilation (see
    [search-operations.md](./search-operations.md)).
  - Written with the knex query builder rather than raw SQL so it also runs on
    the sqlite dev database. A missing link table warns and degrades to "no
    aggregate" rather than failing the whole feed.
  - `keyByPath` matters here: the endpoint takes no query parameters, so
    without it a `?nonce=` flood would mint a distinct cache key per request
    and force a full-catalogue scan each time.
- `GET /api/redirects` — the Strapi **core `find`** route for the Redirect
  collection, granted to the public role, with the `find` action overridden in
  [`src/api/redirect/controllers/redirect.ts`](../src/api/redirect/controllers/redirect.ts).
  Returns the standard `{ data, meta }` envelope of editor-managed redirects
  with a **fixed projection** (`from`, `to`, `statusCode`, `active`); the ISR
  frontend middleware loads it and applies matches before any built-in
  canonicalisation. The controller forces the query shape: results are always
  **active rules only**, sorted by `from`, and caller-supplied `filters`,
  `fields`, `sort` and `populate` are ignored — only `pagination[page]` /
  `pagination[pageSize]` (clamped to 100) are honoured, so inactive/planned
  rules and the editorial `note` field (also `private` in the schema) are never
  readable anonymously. Carries the same guards as the other public reads:
  60/60s rate limit and a 60s response cache keyed by the full URL (the query
  string is pagination, so it is semantically meaningful), attached via the
  `find` action's `config.middlewares` in
  [`src/api/redirect/routes/redirect.ts`](../src/api/redirect/routes/redirect.ts).

## Offer listings

- `GET /api/offers` and `GET /api/deals` — every published offer of that type,
  newest first. `?page=` (≥ 1) and `?pageSize=` (default 24, clamped to 100);
  `?sort=` overrides the default order. Response is
  `{ data, pagination: { page, pageSize, total, pageCount } }`.
- `GET /api/{stores|brands|categories|banks}/:slug/{coupons|deals}` — offers
  for one entity, resolved by slug. These follow the **admin-curated relation
  order** rather than the newest-first default. Same `page`/`pageSize`
  handling.

All of them filter to published, unexpired content; scheduled and expired rows
are never emitted.

## Related stores

`GET /api/{stores|brands|categories|banks}/:slug/related-stores` — Store-only
sidebar suggestions for any entity page. Full contract, ranking and fallback
semantics in [related-stores-api.md](./related-stores-api.md).

## Ratings

`POST /api/{stores|brands|categories|banks}/:slug/rating` with a JSON body
`{ "value": <integer 1–5> }`.

Anonymous, and never cached — every vote must reach the controller. Guards:

- 5 requests per minute per IP (`global::rate-limit`).
- One vote per client per entity, enforced by a
  `UNIQUE(entity_type, entity_document_id, ip_hash)` constraint on the
  `entity_rating_votes` table — a database constraint rather than an
  in-process map, so it survives restarts and holds across nodes. A repeat
  vote returns **429** with an "already rated" message.
- The voter's IP is never stored raw: it is salted with the app key and stored
  as a SHA-256 hash.

Success returns `{ ok: true, ratingAverage, ratingCount }`. A non-integer or
out-of-range `value` is a 400; an unknown slug is a 404. These aggregates are
what the high-rated fallback in `related-stores` sorts on.

## Offer feedback

`POST /api/offer-feedback/:entityType/:documentId` with a JSON body
`{ "result": "worked" | "failed" }`. `entityType` is `coupon` or `deal` and
`documentId` is the offer's Strapi `documentId`.

Anonymous, and never cached — every vote must reach the controller. Guards:

- 10 requests per minute per IP (`global::rate-limit`).
- One vote per client per offer, enforced by a
  `UNIQUE(entity_type, entity_document_id, ip_hash)` constraint on the
  `offer_feedback_votes` table. A repeat vote returns **429** with an
  "already left feedback" message.
- The voter's IP is never stored raw: it is salted with the app key and stored
  as a SHA-256 hash.

Success returns `{ ok: true, workedCount, failedCount }`. An unknown entity
type, invalid document id, or a `result` other than `worked`/`failed` is a
400; an unknown offer is a 404. Counters are bumped with raw Knex — no
document-service write, so a vote never enqueues ISR page regeneration; the
denormalized `workedCount`/`failedCount` surface on the detail-page
aggregates (`coupon-page`, `deal-page`) on their next rebuild.

## Coupon detail aggregate

`GET /api/coupon-page/:id` accepts the Coupon's positive numeric Strapi `id`.
It returns `{ coupon, primaryEntity, relatedCoupons,
relatedDeals, similarStores }` for a published Coupon. The Coupon and related
offer field lists deliberately omit `affiliateLink`; browser activation still
uses the private redeem resolver. Unique-pool relations expose only their name
and Strapi relation identity, never pool codes. The same applies to the Deal
aggregate: Product Deals carry `couponType` and a `uniqueCouponPool` relation
too.

The public URL uses the compact database `id`; redemption continues to use the
Coupon's Strapi `documentId` internally.

## Offer redeem resolver

`GET /api/offer-redeem/:entityType/:documentId`, `entityType` ∈ `coupon`,
`deal`.

**This is a private gateway-only route despite `auth: false`.** It requires
`Authorization: Bearer $ISR_ADMIN_SECRET`, compared with a constant-time
digest comparison. When `ISR_ADMIN_SECRET` is unset it is open in
development and **closed in production** (every request 401s), so a production
instance missing the secret fails shut. The `documentId` must match
`^[a-zA-Z0-9_-]{1,160}$`; anything else is a 404, as is an unknown entity type
or an unpublished offer.

It exists because the core Coupon/Deal `findOne` routes are disabled — public
callers must not be able to resolve an offer and drain its unique-code pool.
It returns `{ data }` with a narrow field set (title, code, affiliate link,
expiry, schedule, content status, `couponType` and the pool name) and named
relations only. Both offer types carry the pool fields — Product Deals draw
per-visitor codes from a unique pool exactly as Coupons do. A `code` stored on
a unique offer is redacted to `null` on the way out, because it is a legacy
leftover, never the code the visitor should receive.

## ISR offer route inventory

`GET /api/isr-offer-routes` returns only the canonical numeric detail routes
and optional update timestamps for currently visible Coupons and Deals. Astro
uses this compact feed to include `/coupon/:id/` and `/deal/:id/` in the
persistent ISR route inventory. The response contains no offer content,
affiliate destination, code, or unique-pool data.

## Unique coupon codes

Plugin routes, mounted under `/unique-coupon` — see
[`src/plugins/unique-coupon/server/src`](../src/plugins/unique-coupon/server/src).

`POST /unique-coupon/redeem` with `{ "poolDocumentId": "...", "activationId":
"..." }` draws one unused code from the pool and marks it used. `activationId`
is optional and identifies ONE click; it is the id the redeem interstitial
already mints per activation (a `crypto.randomUUID()`, with or without dashes).
Anything that is not that shape is ignored rather than rejected — a malformed
id must not cost the visitor their code.

Passing it makes the draw **idempotent for that click**: a reload, a bfcache
restore or a retried request replays the code that activation already claimed
instead of consuming another. A genuinely new click carries a new activation id
and draws a new code. The replay window is 24 hours, so a leaked activation id
is not a permanent read capability for a live code.

Concurrency is handled by an atomic conditional `UPDATE ... FOR UPDATE SKIP
LOCKED` on the code rows, not by locking the pool. Simultaneous claimers step
over each other's in-flight rows and take different codes, so two visitors can
never be handed the same one, and throughput is not one-at-a-time per pool.
Because of that, redemption deliberately does **not** maintain
`unique_coupon_pools.used_codes` — that write targets one shared row and would
reserialize every claimer. The counters are reconciled by `recountPools`
(nightly cron); `GET /unique-coupon/stats/:poolDocumentId` reports live counts.

Anonymous, but behind a dedicated in-memory per-IP policy of **30 redemptions
per minute**, which sets `Retry-After` and returns 429 on overflow. That sits
deliberately ABOVE the ISR gateway's Redis-backed 10/IP/min so the gateway's
limiter — the one that is correct across multiple nodes — is the binding
control; this one is a backstop for a caller that reached Strapi directly. The
policy reads the koa-resolved client IP, never raw `X-Forwarded-For`, because a
spoofable header would let a single caller rotate identities and drain a pool,
and it shares the `RATE_LIMIT_TRUSTED_IPS` socket bypass with the global
limiter.

Responses are status-coded by outcome:

| Outcome | Status | Body |
|---|---|---|
| Code drawn | 200 | `{ success: true, code }` |
| Pool exhausted | **200** | `{ success: false, error: "NO_CODES_AVAILABLE", message }` |
| Any other failure | 503 | `{ success: false, error, message }` |

Pool exhaustion is deliberately a 200 — it is a normal business outcome, not a
server error, and consumers must branch on `success` rather than on the status
code alone. A missing `poolDocumentId` is a 400.

### Running out of codes

The first request that finds a pool empty stamps `exhaustedAt` on it. The
five-minute scheduler then flips every unique offer pointing at that pool to
`contentStatus: "expired"`, so it stops rendering an "unlock" CTA that can no
longer produce a code. Importing more codes clears `exhaustedAt` and the same
sweep brings the offers back — no editor action needed either way.

`exhaustedAt` feeds `computeContentStatus`, NOT the offer row directly, because
`validateOfferLifecycle` recomputes `contentStatus` from the dates on every
human save; a status written anywhere else would silently republish a dead
offer the next time an editor touched it.

The interstitial still redirects to the merchant when a pool is dry — the offer
is usually usable without a code, and stranding the visitor helps nobody. Only
a transport or 5xx failure stops the redirect.

`GET /unique-coupon/stats/:poolDocumentId` (pool totals; 404 on an unknown
pool) and `POST /unique-coupon/upload` (bulk code import, max 100,000 per
call) both require an authenticated **admin** session and are not part of the
public surface.

In production none of this is reachable on the CMS hostname at all: nginx
returns 403 for both `/api/` and `/unique-coupon/` on `cms.couponzguru.com`
(only the admin UI is public there). Browsers call the public site, which
reaches Strapi through the ISR gateway over private networking — so the guards
above are defence in depth behind that boundary, not the only barrier.

Pools and codes themselves are populated by migration phases 05 and 06 — see
[migration/README.md](../migration/README.md).
