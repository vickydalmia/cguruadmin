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
| `GET /api/site-chrome` | anonymous | — | 300s |
| `GET /api/offers`, `GET /api/deals` | anonymous | 60 / 60s | 60s |
| `GET /api/{stores\|brands\|categories\|banks}/:slug/{coupons\|deals}` | anonymous | — | none |
| `GET /api/{stores\|brands\|categories\|banks}/:slug/related-stores` | anonymous | — | 60s |
| `POST /api/{stores\|brands\|categories\|banks}/:slug/rating` | anonymous | 5 / 60s | none (never cached) |
| `GET /api/offer-redeem/:entityType/:documentId` | **bearer secret** | — | none |
| `POST /unique-coupon/redeem` | anonymous | 5 / 60s (plugin policy) | none |
| `GET /unique-coupon/stats/:poolDocumentId` | **admin session** | — | none |
| `POST /unique-coupon/upload` | **admin session** | — | none |

The two `keyByPath` entries ignore the query string entirely, so `?nonce=1`,
`?nonce=2`, … all share one cache entry and cannot be used to force repeated
full-catalog scans.

Route definitions: [`src/api/search/routes/search.ts`](../src/api/search/routes/search.ts),
[`src/api/directory/routes/directory.ts`](../src/api/directory/routes/directory.ts),
[`src/api/homepage/routes/custom.ts`](../src/api/homepage/routes/custom.ts),
[`src/api/deal-of-the-day-page/routes/custom.ts`](../src/api/deal-of-the-day-page/routes/custom.ts),
[`src/api/coupon/routes/custom.ts`](../src/api/coupon/routes/custom.ts),
[`src/api/store/routes/custom.ts`](../src/api/store/routes/custom.ts),
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
> upstream payload that still carries one, so this is a hard cross-repo
> contract — see the rollback coupling in
> [strapi-production-deployment.md](./strapi-production-deployment.md#search-cache-and-index-semantics).

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
`Authorization: Bearer $ISR_REVALIDATE_SECRET` (the `global::search-status-auth`
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

## Offer redeem resolver

`GET /api/offer-redeem/:entityType/:documentId`, `entityType` ∈ `coupon`,
`deal`.

**This is a private gateway-only route despite `auth: false`.** It requires
`Authorization: Bearer $ISR_REVALIDATE_SECRET`, compared with a constant-time
digest comparison. When `ISR_REVALIDATE_SECRET` is unset it is open in
development and **closed in production** (every request 401s), so a production
instance missing the secret fails shut. The `documentId` must match
`^[a-zA-Z0-9_-]{1,160}$`; anything else is a 404, as is an unknown entity type
or an unpublished offer.

It exists because the core Coupon/Deal `findOne` routes are disabled — public
callers must not be able to resolve an offer and drain its unique-code pool.
It returns `{ data }` with a narrow field set (title, code, affiliate link,
expiry, schedule, content status, plus `couponType` and the pool name for
coupons) and named relations only.

## Unique coupon codes

Plugin routes, mounted under `/unique-coupon` — see
[`src/plugins/unique-coupon/server/src`](../src/plugins/unique-coupon/server/src).

`POST /unique-coupon/redeem` with `{ "poolDocumentId": "..." }` draws one
unused code from the pool and marks it used. Anonymous, but behind a dedicated
in-memory per-IP policy of **5 redemptions per minute**, which sets
`Retry-After` and returns 429 on overflow. The policy reads the koa-resolved
client IP, never raw `X-Forwarded-For`, because a spoofable header would let a
single caller rotate identities and drain a pool.

Responses are status-coded by outcome:

| Outcome | Status | Body |
|---|---|---|
| Code drawn | 200 | `{ success: true, code }` |
| Pool exhausted | **200** | `{ success: false, error: "NO_CODES_AVAILABLE", message }` |
| Any other failure | 503 | `{ success: false, error, message }` |

Pool exhaustion is deliberately a 200 — it is a normal business outcome, not a
server error, and consumers must branch on `success` rather than on the status
code alone. A missing `poolDocumentId` is a 400.

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
