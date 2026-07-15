# Related Stores API

Public endpoints, cached for 60 seconds:

- `GET /api/stores/:slug/related-stores`
- `GET /api/brands/:slug/related-stores`
- `GET /api/categories/:slug/related-stores`
- `GET /api/banks/:slug/related-stores`

The four routes share one Store-only implementation in
`src/api/store/services/custom.ts`. Routes are registered in
`src/api/store/routes/custom.ts`.

## Contract

Every route returns Store records in `stores`. It never returns Brand, Category,
or Bank records as suggestions.

```json
{
  "stores": [
    {
      "documentId": "...",
      "name": "Flipkart",
      "slug": "shopping-coupon/flipkart",
      "logo": {},
      "logoAlt": "Flipkart logo",
      "offerCount": 11,
      "sharedCategoryCount": 7
    }
  ]
}
```

The Store route also keeps its legacy `store` field for compatibility. Unknown
source slugs return 404. The default result limit is 6; `?limit=` is clamped to
1-12.

## Category Profile

The service first determines which categories should drive the result:

- **Store:** categories from the Store's active Coupon records and dedicated
  Product Deal records. A Product Deal may relate through `stores` or
  `primaryStore`.
- **Brand:** categories from active Coupons and Product Deals related to the
  Brand.
- **Bank:** categories from active Coupons and Product Deals related to the
  Bank.
- **Category:** the selected Category itself. The service does not derive a
  second category set from its offers.

Coupon code availability does not affect classification. Both code and no-code
offers remain Coupon records; Product Deals are read only from the Deal content
type.

The website may pass category hints it already loaded through
`categoryDocumentIds` or `categorySlugs` (comma-separated, up to 12 unique
values). `categorySource=storeOffers` and `categorySource=entityOffers` indicate
that the supplied category set is authoritative. Category routes always use the
selected Category and ignore category hints.

## Store Selection

For the chosen categories, the service samples up to 320 active Coupons and 320
active Product Deals. It collects only their Store owners; a Product Deal's
`primaryStore` also counts. The current Store is excluded on Store pages.

Each Store is ranked by:

1. Number of shared categories.
2. Number of matching Coupon and Product Deal records.
3. Number of matching records marked popular.
4. Store name and stable document key for deterministic ties.

The ranked candidates are hydrated once, and records without a usable logo are
omitted. The result includes `offerCount` and `sharedCategoryCount` so the UI can
explain the match.

## Fallback

The sidebar should always have Store suggestions. When the source has no usable
categories, or none of the related candidates has displayable Store artwork,
the service falls back to Stores sorted by:

1. Rating average.
2. Rating count.
3. Most recently updated.
4. Name.

Fallback results still require a name, slug, and logo. On a Store page, the
current Store remains excluded. Fallback metrics are zero because those Stores
were not selected through category overlap.

## Operational Guarantees

- Only `contentStatus=published`, unexpired Coupons and Product Deals influence
  matching.
- Results are deterministic for the same catalog state.
- Work is bounded to 12 categories, 120 source records per content type, and
  320 matching records per content type.
- Results update automatically as editors publish, expire, or recategorize
  offers, subject to the 60-second response cache.
- Editors do not maintain a separate related-Store list.

Store slugs may contain nested path segments, for example
`shopping-coupon/flipkart`. Consumers must build links from the returned slug
without assuming every slug is a single path segment.
