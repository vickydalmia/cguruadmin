# Entity page offer ordering

This document defines how Store, Brand, Category, and Bank pages combine
editorial Coupon controls with automatic offer ordering. It is the contract
shared by the Strapi admin, the custom entity-offers API, the storefront, the
offer-status cleanup job, and ISR.

## The three independent controls

### Coupon membership

A Coupon belongs to an entity through the Coupon's `stores`, `brands`,
`categories`, or `banks` relation. This remains the source of truth for which
Coupons appear on an entity page.

Entity editors do not edit the raw mapped `coupons` relation. Adding a Coupon to
`orderedCoupons` or `topPickCoupons` never creates entity membership and never
limits the page to only those selections.

### Top Pick Coupons

`topPickCoupons` is an optional editorial selection:

- It accepts either zero Coupons or 2–4 live Coupons related to the entity.
- Coupon-code and no-code Coupons are treated identically.
- The first two live selections are displayed in exact CMS order.
- The third and fourth selections are expiry buffers. They move into a visible
  position only when an earlier selection is no longer live.
- A displayed Top Pick is removed from the main Coupon list, so the same Coupon
  never appears twice on the page.
- When no Top Picks are selected, the storefront automatically chooses the two
  newest eligible Coupons.
- When only one selected Top Pick remains live, the storefront fills the second
  position with the newest eligible unselected Coupon.
- If fewer than two live eligible Coupons exist, the Top Pick section is hidden.

### Ordered Coupons

`orderedCoupons` is an optional editorial head for the main Coupon list:

- It accepts 0–10 live Coupons related to the entity.
- Editors may choose any ten Coupons from the full entity membership, not only
  the newest ten.
- Dragging the handle or using the up/down buttons changes the saved order.
- Selected Coupons lead the main list in exact CMS order.
- Every remaining related Coupon follows automatically in newest-first order.
- An empty selection means the entire main list uses newest-first order.
- A Coupon cannot be selected in both `topPickCoupons` and `orderedCoupons`.
  The server rejects the whole save if an overlap is submitted.

Product Deals are not part of either Coupon relation. Deals remain automatic
and newest-first. The entity's `showTrendingDeals` switch only controls whether
the Deal section is rendered.

## What “newest” means

Automatic ordering uses these fields in order:

1. `publishedOn` descending — the editor-controlled relevance/bump date.
2. `publishedAt` descending — fallback and tie-breaker.
3. `updatedAt` descending — final tie-breaker.

Editing content does not automatically bump `publishedOn`. The explicit
relevance/bump action owns that behavior.

## Scenario matrix

| Ordered Coupons | Explicit Top Picks | Result |
| --- | --- | --- |
| Empty | Empty | The newest two Coupons become automatic Top Picks. The remaining Coupons form the main list newest-first. |
| 1–10 selected | Empty | Automatic Top Picks use the newest eligible Coupons **excluding the ordered selections**. The main list begins with every ordered Coupon, followed by the remaining Coupons newest-first. |
| Empty | 2–4 selected | The first two live selections are Top Picks in CMS order. The main list is newest-first without the displayed Top Picks. |
| 1–10 selected | 2–4 distinct selections | Explicit Top Picks render in CMS order. The main list begins with the ordered selections, then all remaining Coupons newest-first, excluding displayed Top Picks. |
| Any | One selected Top Pick remains live | The live selection keeps its position and the newest eligible non-ordered, non-selected Coupon fills position two. |
| Any | Fewer than two eligible Top Picks | The Top Pick section is hidden; no Coupon is removed from the main list for that hidden section. |
| Any | Same Coupon submitted to both controls | Save fails atomically with a validation error. Neither relation change is persisted. |

An explicit Top Pick can never consume an Ordered Coupon. This is enforced on
write, and automatic Top Pick fallback also excludes every ID returned in the
API's `orderedCouponIds` projection.

## Expiry, scheduling, and cleanup

Only Coupons with `contentStatus = published` and no elapsed `expiresAt` are
eligible for either picker or public output. Scheduled, expired, unpublished,
and already elapsed Coupons are excluded.

The curated-offer cleanup job removes a Coupon from `topPickCoupons` and/or
`orderedCoupons` when it stops being live. It preserves the order of every
remaining selection. The storefront then applies the fallback rules above on
the next render.

## Pagination

The custom entity Coupon endpoint returns up to ten ordered IDs first. The
ordered head can span multiple API pages when a caller uses a small page size.
After that head is consumed, pagination continues through the newest-first
remainder. `pagination.total` always represents the full entity membership,
not only the editorial selections.

## ISR and sitemap behavior

Saving either entity relation is a page-content change even though Strapi may
only update a relation link table. The document middleware therefore:

1. Detects `topPickCoupons` or `orderedCoupons` in the entity update.
2. Touches the owning entity's `updatedAt` inside the same transaction.
3. Enqueues ISR for the entity route and the normal entity scope.
4. Lets the sitemap observe the entity-page change through the updated entity
   timestamp.

When a Coupon itself changes, ISR relation discovery includes normal membership,
Top Pick selection, and Ordered Coupon selection, so every affected entity page
is invalidated.

Cleanup-driven relation removals report the affected entity paths to the ISR
flow as well. If an affected entity cannot produce a safe route slug, cleanup
requests full revalidation rather than silently leaving a stale page.

## New and migrated entities

Both editorial relations default to empty. Existing/migrated entities therefore
retain automatic newest-first behavior until an editor intentionally selects
Top Picks or Ordered Coupons. No backfill is required.
