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

The dedicated layout API validates the final ordered arrays and rejects a
displayed overlap atomically. The dialog also removes a conflict as soon as an
editor creates it, so the correction is visible before Save. As a backstop,
the nightly reconciliation job
   `removeDisplayedTopPicksFromOrdered` disconnects a displayed Top Pick from
   `orderedCoupons` and logs every removal. It catches drift the dialog cannot
   see — legacy/direct database writes, and the buffer promotion that
   `removeInactiveCuratedOfferRelations` performs when a displayed pick expires.

Generic Content Manager writes retain the repair behavior for compatibility,
but the admin no longer uses relation patches. The layout endpoint receives
the complete final order, so the positional rule is authoritative there.

Until the cron runs, the page still renders correctly: the displayed Top Pick
leaves the main list and the ordered head closes up.

Product Deals are not part of either Coupon relation. Deals remain automatic
and newest-first. The entity's `showTrendingDeals` switch only controls whether
the Deal section is rendered.

## Editing surface

Both relations are edited together in the **Coupon layout** dialog, opened from
the entity's edit-view sidebar (`src/admin/features/coupon-layout/`). Their raw
relation inputs stay hidden from the edit form (`HIDE_FROM_EDIT` in
[`src/lifecycles/content-manager/layout-visibility.ts`](../src/lifecycles/content-manager/layout-visibility.ts)),
so the dialog is the only way in.

They share one screen because they interact: a Coupon displayed as a Top Pick
is removed from the main list, so it cannot also hold an Ordered Coupons
position. The dialog gives each selection half the width, with its own search,
sort, and candidate list, and blocks adding a displayed Top Pick to Ordered
Coupons. Expiry buffers are not blocked — that overlap is legitimate.

Both lists are ordered and support drag or the up/down buttons. Top Picks were
previously append-only even though their first two entries render in CMS order.

The dialog owns a draft. **Cancel** discards it; closing a dirty dialog asks for
confirmation. **Save Coupon layout** sends both complete arrays in one request.
It does not mutate the Content Manager form and does not require a second entity
Save. A failed load is shown as an error with Retry and never as an empty
selection.

The preview is produced by
`POST /entity-coupon-layout/:kind/:documentId/preview` from the pending arrays.
It returns the two authoritative Top Picks and first 30 Newest-view main-list
results without exposing Coupon codes, unique-code pools, or affiliate data.

## Permissions and conflicts

The feature action is **Manage entity coupon layout** under Administration
Panel roles. Super Admin inherits it. The built-in Editor is seeded once; later
manual revocation is preserved. Custom roles need that action plus read and
update access to the relevant Store, Brand, Category, or Bank type. Without
those capabilities the panel shows saved counts and a disabled explanation.

Each load returns the entity `updatedAt` as a version. Save sends that version;
if another editor has saved since the dialog opened, the endpoint returns
`409 Conflict`. Close and reopen the dialog to review the newer order, then
reapply the intended edit.

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

Three things remove a non-live Coupon from curated relations, covering
different paths:

1. **On write.** A Coupon or Deal that stops being published — an editor
   unpublishing it in Content Manager, an import, a script — is stripped from
   curated relations in the same transaction as that write. This is the only
   mechanism that covers a manual unpublish: the five-minute job below acts on
   what its own expiry pass changed, which a hand edit never enters.
2. **Every five minutes.** The lifecycle job targets only Coupons/Deals whose
   status *it* changed in that pass and removes them from curated relations. It
   preserves the order of every remaining selection, so removing a displayed
   Top Pick promotes an expiry buffer into its place. A second pass then drops
   any newly displayed Top Pick out of `orderedCoupons`, scoped to the entities
   the first pass touched.
3. **Nightly.** A full reconciliation remains the safety net for legacy
   corruption or a previously failed targeted pass. Its two scans are guarded
   independently, so one failing cannot cancel the other or the nightly
   consistency event.

Deletes need none of these — the relation row cascades with the document.

All passes contribute to one ISR revalidation for the affected entity pages.
The storefront applies the fallback rules above on the next render.

Because a Coupon can still go stale between the layout dialog loading and the
editor saving, `PUT /entity-coupon-layout/:kind/:documentId` **self-heals**: a
selection entry that was already saved and is no longer live is dropped from
the write and reported back in a `dropped` array, rather than failing the save.
An ineligible id that was *not* already saved is still rejected — the candidate
list only offers live Coupons, so that indicates a race or a client bug.

## Pagination

The custom entity Coupon endpoint returns up to ten ordered IDs first. The
ordered head can span multiple API pages when a caller uses a small page size.
After that head is consumed, pagination continues through the newest-first
remainder. `pagination.total` always represents the full entity membership,
not only the editorial selections.

## ISR and sitemap behavior

The layout endpoint replaces both relations, touches the entity timestamp, and
inserts exactly one entity-route ISR outbox event in the same transaction.
After commit it purges only that entity Coupon response cache before waking the
dispatcher. An order-only save does not reload the global route inventory or
sitemap catalogue.

The panel reports **Saved—refresh queued** until the gateway accepts a path
version, then **Public page updated** once the cached HTML reaches it. Gateway
outages, terminal render failures, and a still-unknown route remain visible as
retryable failures. A gateway response containing `skippedPaths` is never
marked delivered: the gateway refreshes route inventory once, retries the
unknown path, and the outbox retries if it is still absent.

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
