# Generated Entity Deal Pages

This guide explains how generated Product Deal pages work for Strapi operators,
developers, and the future admin-settings UI.

## What the feature creates

Every published Store, Brand, Category, and Bank owns one deterministic Deal
page:

| Entity name | Entity URL | Generated Deal URL |
| --- | --- | --- |
| Amazon India | `/amazon-coupons/` | `/amazon-india-deals/` |
| Mobile Phones | `/mobile/` | `/mobile-phones-deals/` |
| Nike | `/nike-coupons/` | `/nike-deals/` |
| HDFC Bank | `/hdfc-offers/` | `/hdfc-bank-deals/` |

The generated URL is `slugify(entity.name) + "-deals"`. It is independent of
the entity page’s editable `slug`: changing the entity name changes its Deal
URL, while changing only the entity slug does not. Former slug-derived Deal
URLs are not redirected because this route family was corrected before launch.
The generated page contains Product Deal records only; Coupon records are not
included.

The Deal of the Day page also derives its Store and Category “View All” links
from this contract. Selecting Amazon India links to `/amazon-india-deals/`, and
selecting Mobile Phones links to `/mobile-phones-deals/`.

## Default indexing policy

Every generated page is `noindex` by default. Creating a new entity never
automatically creates an indexable search result.

An indexing opt-in becomes effective only when all of these conditions pass:

1. `indexingEnabled` is explicitly `true`.
2. At least one published, actionable Product Deal exists for the entity.
3. The canonical URL is the generated page itself.
4. No entity or active redirect already owns the generated URL.

The API returns `seo.blockers` when one or more conditions fail:

- `indexing-disabled`
- `no-live-deals`
- `canonical-not-self`
- `route-conflict`

Do not treat `indexingEnabled: true` alone as proof that the page is indexable.
Use `resolvedSeo.effectiveIndexable` in the admin UI and `seo.noIndex` in the
public template.

## Which Deals appear

A Deal appears only when it:

- is published and currently visible;
- is not scheduled for the future or expired;
- has a positive sale price;
- has a non-empty affiliate link;
- has the entity in the matching Store, Brand, Category, or Bank relation; and
- passes the shared actionable Product Deal validation.

Results are newest-first. The public API is paginated, while Astro fetches every
page during regeneration so the generated HTML contains the complete catalogue.

## Current administration workflow

The entity edit-form field is intentionally hidden. Do not add
`entityDealPageSeo` to the Store, Brand, Category, or Bank content-manager form
yet. The backend contract is ready for the dedicated settings screen.

Only an authenticated Strapi Super Admin can call the settings endpoints.

These two live on the **admin router**, not the content API, so they carry no
`/api` prefix and authenticate with the admin-panel session — call them from
admin-panel code, not with an API token. They are registered in `src/index.ts`
rather than under `src/api/entity-deal-page/routes/` because Strapi forces
`type: 'content-api'` on every router loaded from `src/api/*/routes`, and the
content API cannot authenticate an admin session at all. `super-admin-only`
asserts the admin strategy and fails closed anywhere else.

### List generated permalinks

```http
GET /entity-deal-page/pages
```

Optional query parameters:

| Parameter | Values | Purpose |
| --- | --- | --- |
| `kind` | `store`, `brand`, `category`, `bank` | Filter entity type |
| `search` | text | Search name, source slug, or permalink |
| `indexState` | `enabled`, `disabled`, `blocked` | Filter effective state |
| `sort` | `name`, `liveDealCount`, `updatedAt`, each optionally `:asc` / `:desc` | Result order (default `name:asc`) |
| `page` | positive integer | Result page |
| `pageSize` | `1`–`250` | Rows per page |

Sorting is applied server-side, before pagination, and always falls back to a
name/type/documentId tiebreak so ties keep a stable order across pages —
hundreds of entities share `liveDealCount: 0`, and an unstable order would make
offset pagination repeat one row while dropping another. An unrecognised `sort`
value falls back to the default rather than erroring. Do not sort the rows in
the client: the response is one page, so a client-side sort would reorder that
page only and misreport which entities have the most Deals.

Example:

```http
GET /entity-deal-page/pages?kind=category&search=mobile&page=1&pageSize=25
```

Each row includes:

- entity type, name, document ID, and numeric ID;
- entity URL and generated permalink;
- live Deal count and latest relevant update time;
- saved `entityDealPageSeo` values;
- resolved SEO values and blockers; and
- `indexState`: `disabled`, `enabled`, or `blocked`.

The list is generated from the entity collections, so newly created entities
appear automatically without creating a separate Deal-page record.

### Enable or edit SEO

```http
PATCH /entity-deal-page/pages/:kind/:documentId
Content-Type: application/json

{
  "data": {
    "entityDealPageSeo": {
      "indexingEnabled": true,
      "metaTitle": "Mobile Deals & Offers",
      "metaDescription": "Compare the latest mobile prices and product deals.",
      "canonicalUrl": "/mobile-deals/",
      "ogTitle": "Latest Mobile Deals",
      "ogDescription": "Handpicked mobile offers and price drops.",
      "ogImage": 123,
      "ogImageAlt": "Latest mobile phone deals"
    }
  }
}
```

Supported fields and limits:

| Field | Limit or rule |
| --- | --- |
| `indexingEnabled` | Boolean; defaults to `false` |
| `metaTitle` | 70 characters |
| `metaDescription` | 170 characters |
| `canonicalUrl` | Root-relative path; no query, fragment, markup, or backslash |
| `ogTitle` | 95 characters |
| `ogDescription` | 200 characters |
| `ogImage` | Image media relation |
| `ogImageAlt` | 125 characters |

Blank optional text values are normalized to `null`. Partial updates preserve
the other saved component fields.

To disable indexing without deleting authored SEO:

```http
PATCH /entity-deal-page/pages/category/CATEGORY_DOCUMENT_ID
Content-Type: application/json

{
  "data": {
    "entityDealPageSeo": {
      "indexingEnabled": false
    }
  }
}
```

## Public APIs

### Resolve and render one page

```http
GET /api/entity-deal-pages/:dealSlug?page=1&pageSize=100
```

Example:

```http
GET /api/entity-deal-pages/mobile-deals?page=1&pageSize=100
```

Response shape:

```json
{
  "data": {
    "route": {},
    "entity": {},
    "seo": {},
    "deals": [],
    "pagination": {}
  }
}
```

The endpoint is anonymous, rate-limited to 60 requests per 60 seconds, and
cached for 60 seconds.

### Fetch route metadata

```http
GET /api/entity-deal-page-routes
```

This returns the minimal route inventory consumed by Astro and ISR:

```json
{
  "data": [
    {
      "entityType": "category",
      "documentId": "CATEGORY_DOCUMENT_ID",
      "id": 42,
      "path": "/mobile-deals/",
      "updatedAt": "2026-07-28T12:00:00.000Z",
      "noIndex": true
    }
  ]
}
```

`updatedAt` is the newer of the entity update and its latest live Deal update.
The endpoint has the same anonymous rate limit and 60-second cache.

## ISR and content updates

Generated Deal pages use on-demand ISR:

1. The route inventory admits the URL.
2. The first visitor renders and caches the page.
3. Deployment/global warming skips generated Deal pages.
4. Deal create, update, delete, expiry, publication, or relation changes
   invalidate every related generated page.
5. A previously visited page is proactively regenerated after invalidation.
6. An unvisited page remains cold until its first request.

Entity edits invalidate the entity page and its name-derived Deal page. A name
change also refreshes route membership so ISR removes the former path and
admits the new one. Deal-page route metadata is refreshed through the `routes`
invalidation scope.

## Sitemap behavior

Noindex pages remain reachable and ISR-cacheable but are excluded from all
sitemaps. Effectively indexable pages enter a dedicated shard family:

- `store-deals`
- `brand-deals`
- `category-deals`
- `bank-deals`

This separation makes generated-page indexing measurable without mixing it with
the main entity sitemap.

## Collision protection

Strapi rejects changes that would make an entity root, generated Deal page, or
active redirect occupy the same URL. Examples:

- naming an entity `Mobile` when another entity name already generates
  `/mobile-deals/`;
- using entity slug `mobile-deals` when any entity name generates that Deal
  route; or
- creating an active redirect from `/mobile-deals/`.

If legacy data already contains a conflict, the generated page remains
`noindex`, and the authored entity route takes precedence at runtime.

## ISR invalidation behavior

Generated entity Deal URLs are conditional routes: they exist only while at
least one actionable live Deal is related to the entity and no route conflict
blocks the generated path. Strapi therefore includes these URLs in the durable
outbox payload's `paths` and marks them in the `optionalPaths` subset.

The ISR gateway refreshes route inventory before resolving absence. A generated
URL that is live or pending is invalidated normally; one that is authoritatively
absent is returned in `removedPaths` and the outbox event can complete. Normal
entity URLs and all other required paths remain strict—an unknown required path
stays in `skippedPaths` and is retried.

## Future admin settings screen

Build the screen from `GET /entity-deal-page/pages`; do not query and merge
the four entity collections in the browser. Recommended columns:

- entity name and type;
- generated permalink with Copy action;
- live Deal count;
- index state and blocker summary;
- last updated time; and
- Edit SEO / Enable indexing action.

After a PATCH, reload the affected row from the list response and display
`resolvedSeo`, not only the submitted values. The option must remain restricted
to Super Admins.

## Verification checklist

Before enabling indexing for a page:

1. Open the generated permalink and confirm the correct entity and Deal cards.
2. Confirm there are no repeated Deals between Top Picks, Gen-Z, Cashback, and
   All Deals.
3. Confirm the canonical exactly matches the generated permalink.
4. Confirm `resolvedSeo.blockers` is empty.
5. Confirm the rendered robots directive allows indexing in production.
6. Confirm the URL appears in the correct `*-deals` sitemap shard.

Related implementation references:

- [`public-api.md`](./public-api.md)
- `src/api/entity-deal-page/`
- `src/components/shared/entity-deal-page-seo.json`
- `src/utils/entity-deal-page-seo-validation.ts`
- `src/isr-outbox/scopes.ts`
