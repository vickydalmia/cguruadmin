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

- It accepts zero Coupons, or 1–4 live Coupons related to the entity. There is
  no minimum: a lone selection keeps position one and the storefront fills
  position two with the newest eligible Coupon.
- The picker is unavailable while the entity has fewer than two live Coupons,
  because the section is hidden at that point anyway. This is an admin-side
  guard only; the server does not reject such a save.
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
- Selected Coupons lead the initial main list in exact CMS order.
- Every remaining related Coupon follows automatically in newest-first order.
- An empty selection means the entire main list uses newest-first order.
- The sort dropdown initially selects **Newest First**. That choice preserves
  the ordered head and freshness-sorts only the remainder. Choosing
  **Recommended**, **Highest Discount**, or **Expiring Soon** is an explicit
  visitor override and sorts the complete matching list by that criterion.
- A Coupon in a **displayed** Top Pick position (the first two) may not also be
  an Ordered Coupon — a displayed Top Pick is removed from the main list, so
  the ordered head would silently lose an entry. **Expiry buffers (positions
  three and four) may be in both**, which is the point of a buffer: it is
  invisible until an earlier pick dies, so it can hold a main-list position
  meanwhile.

### How that rule is enforced

By **repair, not rejection**, in two places:

1. **The dialog, immediately.** When a Coupon ends up in both a displayed Top
   Pick slot and `orderedCoupons`, the Coupon layout dialog drops it from the
   ordered selection in the same edit and says so. The editor sees it happen,
   and the save already carries the right disconnect. The dialog can do this
   because it owns the intended order; the server does not.
2. **The five-minute cron, as a backstop.**
   `removeDisplayedTopPicksFromOrdered` disconnects a displayed Top Pick from
   `orderedCoupons` and logs every removal. It catches drift the dialog cannot
   see — direct API writes, and the buffer promotion that
   `removeInactiveCuratedOfferRelations` performs when a displayed pick expires.

The write validators do not check it at all.

This is deliberate. The rule is positional, and the server cannot resolve the
resulting order of a relation patch: `resultingRelations` keeps first
occurrences and ignores Strapi's `before`/`end` anchors, so a drag-reorder
resolves back to the old order. Worse, the cleanup job writes through Query
Engine and bypasses the document-service middleware — once it promotes a buffer
that is also ordered, a positional validator would reject **every** later save
of that entity, including edits unrelated to Coupons.

Until the cron runs, the page still renders correctly: the displayed Top Pick
leaves the main list and the ordered head closes up.

Product Deals are not part of either Coupon relation. Deals remain automatic
and newest-first. The entity's `showTrendingDeals` switch only controls whether
the Deal section is rendered.

## Editing surface

Both relations are edited together in the **Coupon layout** dialog, opened from
the entity's edit-view sidebar (`src/admin/features/coupon-layout/`). Their raw
relation inputs stay hidden from the edit form (`HIDE_FROM_EDIT` in
`src/index.ts`), so the dialog is the only way in.

They share one screen because they interact: a Coupon displayed as a Top Pick
is removed from the main list, so it cannot also hold an Ordered Coupons
position. The dialog gives each selection half the width, with its own search,
sort, and candidate list, and blocks adding a displayed Top Pick to Ordered
Coupons. Expiry buffers are not blocked — that overlap is legitimate.

The server does **not** validate this; see the enforcement note above.

Both lists are ordered and support drag or the up/down buttons. Top Picks were
previously append-only even though their first two entries render in CMS order.

The dialog also shows the resulting sequence as a list of titles. That preview
reads the public `GET /api/{entity}/:slug/coupons` endpoint — the same one the
storefront consumes — rather than re-deriving the ordering rules, so it cannot
drift from `listEntityOffers`. It is not a page render, and cannot be: entity
pages are served only from the ISR store through the gateway, which has no
page-preview route.

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
| Any | Same Coupon in an expiry-buffer Top Pick slot and in Ordered Coupons | Allowed. It holds its main-list position until an earlier Top Pick stops being live. |
| Any | Same Coupon in a displayed Top Pick slot and in Ordered Coupons | The dialog removes it from Ordered Coupons as you edit. Reached any other way it still renders correctly (the Top Pick leaves the main list), and the cron repairs it within five minutes. |

A *displayed* Top Pick never consumes an Ordered Coupon — see the enforcement
note above. The automatic Top Pick fallback separately excludes every ID
returned in the API's `orderedCouponIds` projection, so a Coupon you positioned
in the main list is never pulled into a Top Pick slot behind your back.

## Expiry, scheduling, and cleanup

Only Coupons with `contentStatus = published` and no elapsed `expiresAt` are
eligible for either picker or public output. Scheduled, expired, unpublished,
and already elapsed Coupons are excluded.

The curated-offer cleanup job (`config/cron-tasks.ts`, every five minutes)
removes a Coupon from `topPickCoupons` and/or `orderedCoupons` when it stops
being live. It preserves the order of every remaining selection, so removing a
displayed Top Pick promotes an expiry buffer into its place.

A second pass then runs — always, not only when something expired — and drops
any newly displayed Top Pick out of `orderedCoupons`. Both passes contribute to
one ISR revalidation for the affected entity pages. The storefront applies the
fallback rules above on the next render.

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
Standalone cleanup invalidation also purges Strapi's public response caches
after commit and before waking ISR, so regeneration cannot consume a
pre-cleanup entity response.

## New and migrated entities

Both editorial relations default to empty. Existing/migrated entities therefore
retain automatic newest-first behavior until an editor intentionally selects
Top Picks or Ordered Coupons. No backfill is required.
