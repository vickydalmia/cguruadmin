# Admin edit-view customizations

This guide describes the maintained CouponzGuru customizations layered onto the
Strapi 5 admin. The file keeps its historical name because the Taxonomies panel
was the first customization documented here, but it now covers the complete
admin composition.

For a file-by-file ownership map, see
[`architecture-and-file-map.md`](architecture-and-file-map.md). The thin admin
entrypoint is [`src/admin/app.tsx`](../src/admin/app.tsx); feature behavior lives
under `src/admin/features`, shared admin hooks/utilities live under
`src/admin/hooks` and `src/admin/utils`, and server-side Content Manager setup
lives under `src/lifecycles`.

## Registration order

Order is part of the application contract. `src/admin/app.tsx` performs the
following work.

### `register(app)`

1. Wrap the stock media field with the Product Deal-aware media input.
2. Replace the global `richtext`, `datetime`, and `boolean` inputs.
3. Register the Checkout Merchant custom field and its lazy-loaded input.
4. Register the **Deal page SEO** menu entry and lazy-loaded page.

The field implementations are:

| Concern | Implementation | Behavior |
|---|---|---|
| Product Deal image | [`deal-aware-media-input.tsx`](../src/admin/features/deal-image/components/deal-aware-media-input.tsx) | Adds Product Deal-specific handling around Strapi's normal media input without replacing media behavior elsewhere. |
| Rich text | [`RichTextEditor.tsx`](../src/admin/components/RichTextEditor.tsx) | Edits the HTML stored by rich-text fields. The server still sanitizes submitted HTML. |
| Datetime | [`DateTimeInput.tsx`](../src/admin/components/DateTimeInput.tsx) | Provides the maintained scheduling input and time-step behavior. |
| Boolean | [`BooleanConfirmInput.tsx`](../src/admin/components/BooleanConfirmInput.tsx) | Requires confirmation before changing a boolean value. |
| Checkout Merchant | [`checkout-merchant-input.tsx`](../src/admin/features/checkout-merchant/components/checkout-merchant-input.tsx) | Selects the Store or Brand where checkout happens and observes affiliate-brand blocking state. |

### `config`

The admin config sets the CouponzGuru auth/menu logo, enables English, and
maintains the login, confirmation, and validation-error translations. The
validation message intentionally directs editors to the Validation problems
panel because Strapi's generic save error does not identify every nested field.

### `bootstrap(app)`

Bootstrap installs the record-lock lease interceptor, then registers:

1. Public-offer-link and bump-to-top document actions.
2. Offer-status tabs in the list-view actions area.
3. Edit-view side panels in the exact order below.
4. The first-column list-entry link hook.
5. Browser-title and Enter-key behavior.

| Order | Panel | Applies to |
|---:|---|---|
| 1 | Record lock | Content types covered by the record-lock contract |
| 2 | Publishing | Coupon and Deal entries |
| 3 | Offer benefits | Coupon and Deal entries |
| 4 | Taxonomies | Coupon and Deal entries |
| 5 | Coupon layout | Store, Brand, Category, and Bank entries configured for curated Coupons |
| 6 | Unique-code import | Unique Coupon Pool entries when the user has import permission |
| 7 | Validation problems | Any Content Manager entry with submit errors or an existing-entry required-field gap |

Each Strapi `PanelComponent` returns either `null` or a descriptor containing
`title` and `content`. Panel registration is unconditional; the panel adapter
owns the model and permission checks.

## Taxonomies panel

The extracted implementation lives in
[`src/admin/features/offer-relations`](../src/admin/features/offer-relations).
[`config.ts`](../src/admin/features/offer-relations/config.ts) is the maintained
model-to-section map. Coupon and Deal currently expose:

- Store: optional single choice (`0–1`).
- Brands, Categories, and Banks: multi-select.

The underlying Strapi schema remains relational and the panel does not rewrite
existing data merely because an entry was opened.

### Persisted selection and form commands

Strapi's relation form value represents a pending `{ connect, disconnect }`
diff, not the complete saved relation. The panel therefore loads the persisted
relation separately, replays the current form commands over it, and writes new
commands through the existing tested relation utilities.

[`use-persisted-relation-selection.ts`](../src/admin/features/offer-relations/use-persisted-relation-selection.ts)
owns that process. It also implements removal, single-choice replacement,
reordering, retry state, and sibling-section reports. Numeric `id` values are
display/API details; durable selection identity uses Strapi 5 `documentId`.

### Candidate search and paging

[`use-relation-candidates.ts`](../src/admin/features/offer-relations/use-relation-candidates.ts)
loads candidates 30 at a time, sorts by the configured main field, debounces
search, drops superseded requests, deduplicates accumulated pages, and exposes
an infinite-scroll sentinel. Relation work begins after the shared
[`use-deferred-mount`](../src/admin/hooks/use-deferred-mount.ts) signal so it
does not compete with the edit view's initial render.

The presentational split is intentional:

- [`relation-section.tsx`](../src/admin/features/offer-relations/relation-section.tsx)
  composes warnings, selected rows, candidate rows, and section limits.
- [`selected-relation-row.tsx`](../src/admin/features/offer-relations/selected-relation-row.tsx)
  owns removal and accessible reorder controls.
- [`relation-candidate-list.tsx`](../src/admin/features/offer-relations/relation-candidate-list.tsx)
  owns search, radio/checkbox rows, loading, empty, blocked, and pagination UI.
- [`relation-multi-select-panel.tsx`](../src/admin/features/offer-relations/relation-multi-select-panel.tsx)
  is the final Strapi panel adapter.

### Affiliate-brand coordination

An affiliate Brand is the offer's only merchant. It cannot coexist with a
Store, another Brand, or a Checkout Merchant that points elsewhere. The admin
provides fail-safe UX for this rule; server validation remains authoritative for
every write path.

[`use-affiliate-relation-context.ts`](../src/admin/features/offer-relations/use-affiliate-relation-context.ts)
combines the Store and Brand section reports, resolves persisted Brand flags,
checks Checkout Merchant compatibility, retries bounded lookup failures, and
blocks additions while required state is unknown. Pure decisions remain in
[`affiliate-exclusion.ts`](../src/admin/utils/affiliate-exclusion.ts).

The Taxonomies panel and Checkout Merchant input render in separate React
trees. [`affiliate-state.ts`](../src/admin/utils/affiliate-state.ts) is the
small external-store bridge between them. Removing an already-selected value
stays possible so an editor can resolve legacy conflicts.

## Coupon layout panel

The Coupon layout panel manages ordered, curated Coupon sections for Store,
Brand, Category, and Bank entity pages. Its adapter is
[`coupon-layout-panel.tsx`](../src/admin/features/coupon-layout/components/coupon-layout-panel.tsx),
and it reuses the deferred-mount hook. Route behavior, permissions, payloads,
concurrency, and ordering are documented separately in
[`entity-page-offer-ordering.md`](entity-page-offer-ordering.md).

This is distinct from the Taxonomies panel: Taxonomies edits relations on one
Coupon or Deal; Coupon layout edits an entity page's ordered Coupon curation.

## Unique-code import

[`unique-code-import-panel.tsx`](../src/admin/features/unique-code-import/unique-code-import-panel.tsx)
is a small permission- and model-aware adapter around the existing
[`UniqueCodeImport.tsx`](../src/admin/components/UniqueCodeImport.tsx). It only
renders for `api::unique-coupon-pool.unique-coupon-pool` when RBAC grants
`plugin::unique-coupon.codes.import`.

## Validation problems

[`validation-problems-panel.tsx`](../src/admin/features/validation-problems/validation-problems-panel.tsx)
renders submitted form errors for any model. On existing entries without submit
errors, it can also show fields that became required after the record was
created. It does not render the pending-required scan for a new entry.

[`error-location.ts`](../src/admin/features/validation-problems/error-location.ts)
contains the pure nested-error flattener, human-readable path descriptions, and
homepage image hints. Keeping these transformations pure makes complex
repeatable-component errors testable without rendering the panel.

## List links and browser behavior

[`linkify-first-column.tsx`](../src/admin/features/list-entry-links/linkify-first-column.tsx)
uses the Content Manager table hook to turn a safe first text column into a real
edit link while preserving the displayed cell value.

[`bootstrap-admin-dom.ts`](../src/admin/utils/bootstrap-admin-dom.ts) keeps the
browser title branded and suppresses accidental Enter-key form submission for
ordinary single-line inputs. It deliberately leaves Content Manager search,
comboboxes, autocomplete controls, textareas, and rich-text editing functional.

## Server support

The client customizations depend on server registration and bootstrap code:

- [`register-application.ts`](../src/lifecycles/register-application.ts)
  registers the Checkout Merchant custom field, admin route groups/RBAC, and
  Document Service middleware in order.
- [`admin-routes.ts`](../src/lifecycles/admin-routes.ts) owns Deal-page SEO,
  Coupon-layout, and record-lock route registration.
- [`layout-visibility.ts`](../src/lifecycles/content-manager/layout-visibility.ts)
  removes panel-owned fields from normal edit layouts so editors do not see two
  competing controls.
- [`relation-configuration.ts`](../src/lifecycles/content-manager/relation-configuration.ts)
  maintains relation search/readability and navigation-field placement.
- [`content-write-document-middleware.ts`](../src/document-middlewares/content-write-document-middleware.ts)
  keeps write validation, transactional maintenance, invalidation, and
  record-lock release around the actual Document Service write.

See [`architecture-and-file-map.md`](architecture-and-file-map.md) for the full
server lifecycle and middleware file map.

## Safe change checklist

When changing these customizations:

1. Preserve registration and side-panel order unless the product behavior is
   intentionally changing.
2. Keep selection/blocking decisions in the tested utilities; do not duplicate
   them inside row components.
3. Keep Content Manager layout hiding aligned with the fields owned by panels.
4. Treat unknown affiliate state as blocked for additions while allowing
   removals.
5. Build the admin after changing lazy-import paths or panel adapters.
6. Run `yarn test`, `yarn build`, and `git diff --check`.

Useful focused tests include the admin relation utilities, affiliate exclusion,
error-location helpers, lifecycle registration order, write-validation order,
and Document Service middleware characterization tests.
