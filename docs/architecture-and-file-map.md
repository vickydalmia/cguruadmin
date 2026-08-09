# Architecture and file map

This document explains where CouponzGuru CMS behavior lives and which file to
change for each major concern. It covers every file introduced, moved, or
updated by the entrypoint modularization, then summarizes the wider application
by subsystem. Generated output and repetitive Strapi schema/controller files
are intentionally represented by directory rather than listed one by one.

## Runtime overview

`cguruadmin` is one Strapi 5 application with three responsibilities:

1. The editorial CMS and its customized React admin panel.
2. The public and internal API used by the storefront and ISR services.
3. The producer and dispatcher of durable ISR invalidation events.

The two framework entrypoints are deliberately thin:

- [`src/admin/app.tsx`](../src/admin/app.tsx) composes admin registration,
  branding, fields, actions, hooks, and side panels.
- [`src/index.ts`](../src/index.ts) delegates Strapi `register`, `bootstrap`, and
  `destroy` to lifecycle modules. It also preserves the two public hint-map
  exports used by tests and tooling.

## Execution flows

### Admin startup

`src/admin/app.tsx` performs these operations in order:

1. Replace Product Deal media handling, then the global rich-text, datetime,
   and boolean inputs.
2. Register the Checkout Merchant custom field and lazy input.
3. Register the generated Deal-page SEO menu screen.
4. Install the record-lock lease interceptor.
5. Register public-link and bump document actions, then offer-status list tabs.
6. Register side panels in this exact order: Record lock, Publishing, Offer
   benefits, Taxonomies, Coupon layout, Unique-code import, Validation problems.
7. Register real links for first-column list cells and install the title/Enter
   key DOM behavior.

### Server registration and bootstrap

[`registerApplication`](../src/lifecycles/register-application.ts) registers the
Checkout Merchant server field, the admin route groups and RBAC action, then the
Document Service middlewares. Record locking must remain before content writes.

[`bootstrapApplication`](../src/lifecycles/bootstrap-application.ts) runs its
tasks sequentially: permission seed, trusted-IP warning, curated-relation
filtering, database reconciliation, search initialization, Content Manager
configuration, upload warnings, and ISR outbox startup. `destroyApplication`
stops the outbox.

### Content write

The content-write middleware keeps validation and invalidation around one
transaction:

1. Bypass non-write actions directly to the next middleware.
2. Run the ordered write-validation pipeline and retain any advisory-lock
   release function.
3. Read the before-write snapshot sequentially.
4. Execute the Strapi write through `runContentTransaction`.
5. Inside that transaction, apply timestamps, deleted-merchant cleanup,
   homepage override filling, and affiliate cascades; retain the ordered
   inactive-curation cleanup callback.
6. Merge before/after ISR scopes, handle identity and redirect special cases,
   run inactive-curation cleanup, calculate rerouted-offer scopes, and build
   the outbox payload.
7. Only after commit, purge process caches, log the durable event, and wake the
   outbox.
8. Release the advisory lock in `finally`.

Do not parallelize the snapshot or bootstrap reads. Do not replace ambient
`strapi.db.query`/`strapi.documents` operations with a raw pool connection
inside the content transaction.

## Admin modularization files

### Entrypoint and shared adapters

| File | Responsibility |
|---|---|
| [`src/admin/app.tsx`](../src/admin/app.tsx) | Thin Strapi admin composer. Preserves field, action, hook, menu, and side-panel registration order. |
| [`src/admin/hooks/use-deferred-mount.ts`](../src/admin/hooks/use-deferred-mount.ts) | Shared idle-mount signal used by relation-heavy panels so their requests do not compete with the edit view's first load. |
| [`src/admin/utils/affiliate-state.ts`](../src/admin/utils/affiliate-state.ts) | `useSyncExternalStore` bridge between the Taxonomies panel and Checkout Merchant input, which render in separate React trees. |
| [`src/admin/utils/bootstrap-admin-dom.ts`](../src/admin/utils/bootstrap-admin-dom.ts) | Rewrites the browser title and prevents accidental Enter-key form submission while preserving search and combobox behavior. |
| [`src/admin/features/checkout-merchant/components/checkout-merchant-input.tsx`](../src/admin/features/checkout-merchant/components/checkout-merchant-input.tsx) | Existing combined Store/Brand picker; now consumes the shared affiliate-state bridge. |
| [`src/admin/features/coupon-layout/components/coupon-layout-panel.tsx`](../src/admin/features/coupon-layout/components/coupon-layout-panel.tsx) | Existing Coupon layout side-panel adapter; now consumes the shared deferred-mount hook. |

### Offer relations

| File | Responsibility |
|---|---|
| [`config.ts`](../src/admin/features/offer-relations/config.ts) | Coupon/Deal taxonomy section definitions and the candidate page size. Store is optional single-choice (`0–1`); Brand, Category, and Bank are multi-select. |
| [`types.ts`](../src/admin/features/offer-relations/types.ts) | Relation configuration, sibling-selection report, and affiliate-context contracts. |
| [`relation-multi-select-panel.tsx`](../src/admin/features/offer-relations/relation-multi-select-panel.tsx) | Strapi side-panel adapter and section composer; owns affiliate retry UI and section dividers. |
| [`relation-section.tsx`](../src/admin/features/offer-relations/relation-section.tsx) | One taxonomy section's warnings, selected rows, candidate controls, limits, and explanatory copy. |
| [`selected-relation-row.tsx`](../src/admin/features/offer-relations/selected-relation-row.tsx) | Selected-item row with remove, drag/drop, and accessible up/down controls. |
| [`relation-candidate-list.tsx`](../src/admin/features/offer-relations/relation-candidate-list.tsx) | Search input and radio/checkbox candidate list with loading, empty, blocked, and infinite-scroll states. |
| [`use-persisted-relation-selection.ts`](../src/admin/features/offer-relations/use-persisted-relation-selection.ts) | Loads the full saved relation, merges the current form diff, reports sibling state, and builds utility-backed select/remove/reorder commands. |
| [`use-relation-candidates.ts`](../src/admin/features/offer-relations/use-relation-candidates.ts) | Debounced candidate search, pagination, scoped filters, cancellation, and scroll-sentinel paging. |
| [`use-affiliate-relation-context.ts`](../src/admin/features/offer-relations/use-affiliate-relation-context.ts) | Resolves persisted Brand affiliate flags with bounded retry, combines Store/Brand/merchant state, and publishes checkout blocking. |

### Other extracted admin concerns

| File | Responsibility |
|---|---|
| [`src/admin/features/validation-problems/error-location.ts`](../src/admin/features/validation-problems/error-location.ts) | Pure nested-error flattening, human path labels, and homepage image-size hints. |
| [`src/admin/features/validation-problems/validation-problems-panel.tsx`](../src/admin/features/validation-problems/validation-problems-panel.tsx) | Shows submitted errors or existing required-field gaps for any Content Manager model. |
| [`src/admin/features/unique-code-import/unique-code-import-panel.tsx`](../src/admin/features/unique-code-import/unique-code-import-panel.tsx) | Permission-aware side-panel adapter for the existing unique-code bulk importer. |
| [`src/admin/features/list-entry-links/linkify-first-column.tsx`](../src/admin/features/list-entry-links/linkify-first-column.tsx) | Content Manager list hook that replaces a safe first text cell with a real edit link. |

## Server lifecycle files

### Lifecycle composition

| File | Responsibility |
|---|---|
| [`src/index.ts`](../src/index.ts) | Thin Strapi lifecycle adapter and compatibility re-exports for `COMPONENT_FIELD_DESCRIPTIONS` and `CONTENT_TYPE_FIELD_HINTS`. |
| [`src/lifecycles/register-application.ts`](../src/lifecycles/register-application.ts) | Server register composer: custom field, admin routes/RBAC, then Document Service middleware registration. |
| [`src/lifecycles/admin-routes.ts`](../src/lifecycles/admin-routes.ts) | Registers generated Deal-page SEO, entity Coupon layout, and record-lock admin route groups plus the Coupon-layout RBAC action. |
| [`src/lifecycles/bootstrap-application.ts`](../src/lifecycles/bootstrap-application.ts) | Authoritative ordered bootstrap/destroy composer. |
| [`src/lifecycles/bootstrap-permissions.ts`](../src/lifecycles/bootstrap-permissions.ts) | One-time default Editor grant for Manage entity coupon layout; manual later revocation is preserved. |
| [`src/lifecycles/bootstrap-curated-offers.ts`](../src/lifecycles/bootstrap-curated-offers.ts) | Registers live-offer relation filtering and logs the schema-derived curated relation inventory. |
| [`src/lifecycles/bootstrap-reconciliation.ts`](../src/lifecycles/bootstrap-reconciliation.ts) | Sequentially invokes post-schema content-contract, site-selection, festival-tab, search-index, and unique-code reconcilers. |
| [`src/lifecycles/bootstrap-warnings.ts`](../src/lifecycles/bootstrap-warnings.ts) | Emits trusted-IP, S3, and upload MIME configuration warnings without blocking boot. |

### Content Manager configuration

| File | Responsibility |
|---|---|
| [`layout-visibility.ts`](../src/lifecycles/content-manager/layout-visibility.ts) | Removes panel-owned relations and fields from content-type/component edit layouts while retaining intended offer list columns. |
| [`relation-configuration.ts`](../src/lifecycles/content-manager/relation-configuration.ts) | Pins relation search fields, checks role readability, and places the navigation icon field. |
| [`entry-titles.ts`](../src/lifecycles/content-manager/entry-titles.ts) | Pins component and single-type main fields used as Content Manager entry titles. |
| [`component-field-hints.ts`](../src/lifecycles/content-manager/component-field-hints.ts) | Builds and applies component-field descriptions, including image-rule-derived help. |
| [`content-type-field-hints.ts`](../src/lifecycles/content-manager/content-type-field-hints.ts) | Builds and applies top-level field hints/labels from validation rules and maintained mirror entries. |
| [`permission-and-upload.ts`](../src/lifecycles/content-manager/permission-and-upload.ts) | Ensures public reads, Media Library settings, and Footer/Global Super Admin restrictions. |
| [`list-layout.ts`](../src/lifecycles/content-manager/list-layout.ts) | Pins offer status, sortable list columns, and full-width edit fields. |
| [`section-labels.ts`](../src/lifecycles/content-manager/section-labels.ts) | Pins single-type section labels, descriptions, and form ordering from shared constants. |
| [`src/utils/homepage-overrides.ts`](../src/utils/homepage-overrides.ts) | Fills empty component override labels from their selected relation inside the ambient transaction. |

## Document Service middleware files

| File | Responsibility |
|---|---|
| [`register-document-middlewares.ts`](../src/document-middlewares/register-document-middlewares.ts) | Installs record locking first and content-write handling second. |
| [`record-lock-document-middleware.ts`](../src/document-middlewares/record-lock-document-middleware.ts) | Enforces active Content Manager leases, including single types and same-user competing tabs. |
| [`content-write-document-middleware.ts`](../src/document-middlewares/content-write-document-middleware.ts) | Orchestrates validation, snapshot, transaction, maintenance, invalidation, post-commit cache work, and lock release. |
| [`content-write-types.ts`](../src/document-middlewares/content-write-types.ts) | Internal context, snapshot, and transactional-maintenance interfaces shared by the write stages. |
| [`capture-write-snapshot.ts`](../src/document-middlewares/capture-write-snapshot.ts) | Sequential before-write reads for redirects, offer state/scope, public identity, festive fields, entity-offer membership, and Brand affiliate state. |
| [`apply-transactional-maintenance.ts`](../src/document-middlewares/apply-transactional-maintenance.ts) | Runs transaction-bound timestamps, deleted-merchant cleanup, homepage override filling, and affiliate cascade; returns the deferred inactive-curation cleanup step. |
| [`build-write-invalidation.ts`](../src/document-middlewares/build-write-invalidation.ts) | Merges ISR scopes, handles identity/redirect/reroute cases, expands landing pages, and builds the durable outbox payload. |

### Deliberate operational behavior

These are intentional trade-offs, not oversights — change them knowingly:

- **Rerouted-offer scope cap is 10** (`build-write-invalidation.ts`,
  `REROUTED_OFFER_SCOPE_CAP`; was 25 pre-modularization). A Store/Brand save
  or delete that reroutes more than 10 offers escalates to a full-site ISR
  rebuild instead of per-offer scopes, because each scope read is ~5 queries
  serialized on the ambient transaction connection **while the advisory
  locks are held** — a long hold turns concurrent saves into lock-timeout
  rejections.
- **Write locks are all-or-nothing and set-wide fail-closed**
  (`write-serialization.ts` + `write-validation/run.ts`). All of a save's
  lock domains are taken on ONE pooled connection; a failed statement
  poisons that transaction, so partial acquisition cannot exist. A save
  whose domain set contains a fail-closed domain (`affiliate` — i.e. every
  Brand save, and Store saves touching offers or clones) therefore REJECTS
  with "Another save touching related records is still in progress" if ANY
  of its locks times out (8s), where the pre-consolidation code skipped a
  failed fail-open lock and proceeded partially serialized. Accepted cost:
  under heavy identity-lock contention some brand saves fail visibly
  instead of racing invisibly.
- **Store/Brand deletes pre-read and invalidate offers**
  (`capture-write-snapshot.ts` + `build-write-invalidation.ts`): member
  offers (relation) AND offers whose `checkoutMerchant` references the
  deleted merchant are collected before the delete (2 extra queries) and
  invalidated per-offer; if a pre-read fails, the payload escalates to a
  full rebuild — fail-safe over fail-silent (pre-modularization deletes
  emitted only the entity's own scope and could leave stale offer pages).

## Modularization tests

| File | Responsibility |
|---|---|
| [`src/lifecycles/register-application.test.ts`](../src/lifecycles/register-application.test.ts) | Pins custom-field, route-group, RBAC-action, and middleware registration order. |
| [`src/document-middlewares/content-write-helpers.test.ts`](../src/document-middlewares/content-write-helpers.test.ts) | Characterizes snapshot fail-safe defaults and redirect note-only invalidation suppression. |
| [`src/api/search/services/search-migrations.test.ts`](../src/api/search/services/search-migrations.test.ts) | Verifies search reconciliation still precedes runtime initialization through the new bootstrap modules. |
| [`src/utils/content-contract-reconciliation.test.ts`](../src/utils/content-contract-reconciliation.test.ts) | Verifies content-contract reconciliation is wired before search initialization. |
| [`src/utils/site-selection-reconciliation.test.ts`](../src/utils/site-selection-reconciliation.test.ts) | Verifies site-selection reconciliation is wired before search initialization. |

## Wider repository map

| Path | Responsibility |
|---|---|
| `src/api/` | Strapi content types and custom controllers, routes, and services. Core offer reads are intentionally replaced by controlled custom APIs. |
| `src/components/` | Reusable Strapi component schemas used inside single types and collection types. |
| `src/constants/` | Contracts shared across admin and server code, including checkout merchant, section labels, images, and record-lock headers. |
| `src/isr-outbox/` | ISR scope computation, durable event payloads, transaction wrapper, dispatcher runtime, and operational logging. |
| `src/middlewares/` | Koa request middleware for cache headers, rate limits, sanitization, and other HTTP concerns. |
| `src/policies/` | Route authorization policies, including admin-only and machine-secret checks. |
| `src/utils/` | Cross-feature validation, relation, identity, content-status, timestamp, and response helpers. |
| `src/utils/write-validation/` | Ordered write mutators/validators, problem aggregation, and advisory-lock coordination. |
| `src/plugins/unique-coupon/` | Local Strapi plugin for importing and managing unique coupon codes. |
| `config/` | Strapi runtime, database, plugin, middleware, cron, and environment-backed configuration. |
| `database/` | User migrations and post-schema reconciliation scripts. |
| `docs/` | Developer and operator contracts for APIs, admin behavior, deployment, search, and data flows. |
| `migration/` | Independent WordPress-to-Strapi migration package with its own dependencies, entrypoint, checkpoints, and runbooks. |

## Where to make a change

| Goal | Start here |
|---|---|
| Add or reorder an admin side panel | `src/admin/app.tsx`, then the owning `src/admin/features/*` module |
| Add a Coupon/Deal taxonomy section | `src/admin/features/offer-relations/config.ts` and the server layout-visibility table |
| Change affiliate selection UX | Offer-relation hooks plus `src/admin/utils/affiliate-exclusion.ts`; keep server validation authoritative |
| Change server admin routes or Coupon-layout RBAC | `src/lifecycles/admin-routes.ts` |
| Change bootstrap order | `src/lifecycles/bootstrap-application.ts`; keep tasks sequential |
| Change post-schema reconciliation | `src/lifecycles/bootstrap-reconciliation.ts` and the matching `database/*.js` reconciler |
| Add a write validator | `src/utils/write-validation/steps.ts`; preserve the pinned order tests |
| Change transaction-bound write maintenance | `src/document-middlewares/apply-transactional-maintenance.ts` |
| Change ISR invalidation caused by writes | `src/document-middlewares/build-write-invalidation.ts` and `src/isr-outbox/` |
| Change Content Manager labels/layouts | The appropriate `src/lifecycles/content-manager/*` module, not the admin UI's Configure view screen |
