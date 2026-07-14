# Related Stores — how the recommendation works

*API:* `GET /api/stores/:slug/related-stores` · public, no login required · responses cached for 60 seconds
*Used by:* the "Related Stores" block in the store-page sidebar
*Code:* `src/api/store/services/custom.ts` (`relatedStores`), route in `src/api/store/routes/custom.ts`

## The one-line version

> A store is "related" when its **live coupons and deals sit in the same categories** as the current store's offers — and the more categories it shares (and the more offers it has in them), the higher it ranks.

We do not maintain a manual "related stores" list anywhere. The recommendations are computed automatically from the offer catalog, so they stay fresh as editors add or unpublish offers — no extra curation work.

## How a request flows

Using **Amazon** as the example:

1. **Find the store.** Look up the store by its slug (`amazon`). Unknown slug → 404.

2. **Build Amazon's "interest profile" — the categories its offers live in.**
   - Normally the website already knows these (it just fetched Amazon's coupons and deals to render the page) and passes them along, which keeps the request cheap.
   - If not provided, the API works them out itself: it samples up to 120 of Amazon's most popular/recent published coupons and 120 deals, and collects their categories.
   - Up to **12 categories** are used. If a store's offers have no categories at all, the API returns an empty list — there is nothing to match on.

3. **Find candidate offers in those categories.** Fetch up to 320 published coupons + 320 published deals (most popular first, then newest) belonging to *any* of those categories — along with the stores that own them.

4. **Score every store that owns one of those offers** (Amazon itself is excluded):
   - **Shared categories** — how many of Amazon's categories this store's offers cover (breadth),
   - **Offer count** — how many matching offers it has (depth),
   - **Popular hits** — how many of those offers are flagged "popular".

5. **Rank and pick the top 6** (the widget can ask for up to 12 via `?limit=`):
   1. Most **shared categories** wins first,
   2. then most **offers**,
   3. then most **popular offers**,
   4. alphabetical as the final tie-break (so results are stable, not random).

6. **Return the winners** with name, slug, logo, and their scores (`offerCount`, `sharedCategoryCount`) so the UI can show context like "11 offers".

## Why "categories first, offers second"?

Real result for Amazon today:

| Rank | Store | Offers in shared categories | Shared categories |
|---|---|---|---|
| 1 | Flipkart | 11 | 7 |
| 2 | Croma Retail | 6 | 6 |
| 3 | Vijay Sales | 5 | 4 |
| 4 | Lenovo | 41 | 3 |
| 5 | Asus | 8 | 3 |
| 6 | RealMe | 6 | 3 |

Lenovo has by far the most offers (41) but ranks **below** Croma (6 offers), because Croma overlaps Amazon in 6 different categories while Lenovo only overlaps in 3. A store that is similar *across the board* (a marketplace rival like Flipkart) beats a narrow specialist with a deep catalog — which is the behavior we want for "stores like this one". A brand with many offers in one shared category still appears, just lower.

## Product-relevant rules & guarantees

- **Only published content counts.** Draft or unpublished coupons/deals never influence the ranking and never appear.
- **Self-updating.** Publish new offers or re-categorize a store's offers, and its related-store list adjusts on its own (within the 60-second cache window).
- **Deterministic.** Same catalog → same order. No randomness between page loads.
- **Bounded cost.** Hard caps (12 categories, 320 candidate offers per type) plus the 60-second cache keep the endpoint fast no matter how large the catalog grows.
- **Levers editors already control:**
  - *Categorizing offers well* is what drives quality — an offer with no categories contributes nothing to recommendations.
  - The *"popular"* flag on an offer acts as a tie-breaker boost for its store.
- **No manual override today.** If product ever wants to pin/exclude specific stores (e.g. never recommend a direct competitor), that would be a small follow-up feature — the ranking has a single, well-defined sort step where such rules would slot in.

## Known data caveat

Store slugs are inconsistent in shape (e.g. `shopping-coupon/flipkart` contains a `/`, while others are flat like `croma-coupons`). The API returns slugs as stored; the frontend link-building should be checked against nested slugs, or the slugs cleaned up in the CMS.
