# Admin Edit-View Customizations

How the Strapi v5 admin bundle is customized: the **Taxonomies** side panel this
file is named after, the two panels that grew beside it, the four replaced field
types, and the server-side bootstrap that keeps the edit view consistent with
them.

> **What this doc is for.** It explains *why* these customizations exist and what
> contract each one holds, so you can change them without re-deriving the intent.
> It is deliberately not a transcription: the maintained references are
> [`src/admin/app.tsx`](../src/admin/app.tsx) plus
> [`src/admin/features/taxonomy-panel/`](../src/admin/features/taxonomy-panel/)
> (client-side) and [`src/index.ts`](../src/index.ts) plus
> [`src/bootstrap/`](../src/bootstrap/) (server-side). When this doc and the
> code disagree, the code wins.

---

## 1. Overview

### Problem

Strapi v5's default relation widget fetches options one small batch at a time and
renders a dropdown. Our taxonomy collections hold thousands of stores and brands,
which makes that UX painful: scrolling is sluggish, finding an item by name is
awkward, bulk-selecting costs many round trips — and every relation field gets
its own widget, so a deal or coupon edit view is dominated by them.

Separately, several stock field inputs did not survive QA: the markdown editor
could not edit the HTML our richtext fields actually store, the datetime picker
stepped in 15-minute jumps, and booleans flipped on a stray click. (Slug fields
were once a fourth case — a custom uid input with a Regenerate button — but
editors regenerating live slugs proved worse than the stock behavior, so slugs
are now plain regex-validated `string` attributes typed by hand.)

### Solution

1. Replace the relation widgets with **side panels** that render compact
   searchable candidate controls plus a selected list, with pagination and
   infinite scroll. Store is a single-choice radio; the other taxonomies stay
   multi-select checkboxes.
2. **Hide the default relation widgets** for the fields those panels own, so
   nothing is duplicated and the main form stays clean.
3. Replace the four problem field types globally in the admin `register()` hook,
   so every content type inherits the fix without per-field configuration.

### Files

| File | Purpose |
|------|---------|
| [`src/admin/app.tsx`](../src/admin/app.tsx) | Admin entry point: field-type registrations, admin config/translations, and panel wiring |
| [`src/admin/features/taxonomy-panel/`](../src/admin/features/taxonomy-panel/) | The Taxonomies panel implementation (config, relation sections, affiliate toggle) |
| [`src/admin/components/RichTextEditor.tsx`](../src/admin/components/RichTextEditor.tsx) | TipTap WYSIWYG registered for `richtext` |
| [`src/admin/components/DateTimeInput.tsx`](../src/admin/components/DateTimeInput.tsx) | `datetime` picker with 5-minute steps |
| [`src/admin/components/BooleanConfirmInput.tsx`](../src/admin/components/BooleanConfirmInput.tsx) | `boolean` toggle behind a confirmation dialog |
| [`src/index.ts`](../src/index.ts) | Server lifecycle wiring; the boot-time view config lives in [`src/bootstrap/`](../src/bootstrap/) — [`content-manager-layouts.ts`](../src/bootstrap/content-manager-layouts.ts) is what hides the panel-owned relations |
| [`src/constants/homepage-sections.ts`](../src/constants/homepage-sections.ts), [`src/constants/deal-of-the-day-sections.ts`](../src/constants/deal-of-the-day-sections.ts), [`src/constants/homepage-images.ts`](../src/constants/homepage-images.ts), [`src/constants/offer-taxonomy.ts`](../src/constants/offer-taxonomy.ts) | Section labels, image size rules, and the offer taxonomy field list shared by the admin bundle and the server |

The field replacements are maintained product behavior, not release-specific
patches. Their acceptance cases are included in §7.

---

## 2. The admin entry point

The default export of [`src/admin/app.tsx`](../src/admin/app.tsx) implements
three of Strapi's admin hooks.

### `register(app)` — global field-type replacements

Four `app.addFields({ type, Component })` calls swap the built-in input for every
field of that type, across every content type:

| Type | Component | Why |
|---|---|---|
| `richtext` | `RichTextEditor` | Fields store HTML (WP-migrated, rendered raw on the site); the stock markdown editor cannot edit it. Anything outside the server allowlist is stripped on save by [`src/utils/sanitize-richtext.ts`](../src/utils/sanitize-richtext.ts). |
| `datetime` | `DateTimeInput` | 5-minute time steps instead of 15, for coupon scheduling precision. |
| `boolean` | `BooleanConfirmInput` | Confirmation dialog before the toggle flips; the form value changes only after the editor confirms. |

The registry key must be the **raw attribute type**. In particular `richtext`,
not the Strapi v4 `wysiwyg` key, which silently does nothing in v5.

### `config` — branding, locale, translations

Replaces the Strapi logo in the auth and menu views, declares `locales: ['en']`,
and supplies a translations block. The translation overrides are load-bearing,
not cosmetic: they rewrite the login welcome copy, relabel the media-library
dialog's confirm action, and — most importantly — replace the generic
content-manager validation error with a message that points editors at the
Validation problems panel (§5). The pre-save check never reaches the server, so
that panel is the only place the real problem is visible.

### `bootstrap(app)` — panels and two document-level behaviors

Registers every edit-view side panel in one `addEditViewSidePanel` call on
the content-manager plugin's `apis` object, in order: Record lock, Publishing,
Offer benefits, Taxonomies, Coupon layout, Unique code import, Validation
problems. Each panel decides for itself whether it applies to the current
model (§3–§5), so registration is unconditional.

`bootstrap` also installs two document-level behaviors, both guarded on
`document` being defined:

- **Title rewriter.** Replaces `Strapi` with `CouponzGuru` in `document.title`,
  and keeps doing so via a `MutationObserver` on the `<title>` element as the
  admin SPA navigates.
- **Enter-key suppressor.** A capture-phase `keydown` listener that swallows
  Enter on single-line text inputs inside `/content-manager/` routes, because
  pressing Enter while typing a name used to submit the form and create the
  entry. It deliberately leaves comboboxes, autocomplete inputs, textareas, and
  the rich-text editor alone, and — critically — skips inputs inside
  `form[role="search"]`: Strapi's search bar has no submit button, so Enter is
  its only trigger and swallowing it would break search on every content type.

---

## 3. The Taxonomies panel

`RelationMultiSelectPanel` renders for any model present in `RELATION_CONFIG`,
and returns `null` for everything else. Today that map covers `api::deal.deal`
and `api::coupon.coupon`, each with the same four relations — stores, brands,
categories, banks.

A `PanelComponent` returns a **description object**, `{ title, content }`, not
JSX. Strapi renders the panel chrome itself and mounts `content` inside it;
returning JSX directly fails with an unhelpful error.

### The config shape

One `RelationConfig` describes one section of the panel:

```ts
type RelationConfig = {
  field: OfferTaxonomyField;      // attribute name on the parent (form key)
  target: string;                 // related content-type UID
  label: string;                  // heading + search placeholder
  singularLabel: string;          // noun in generic single-choice guidance
  minSelections?: number;
  maxSelections?: number;
};
```

Candidates are always labeled, searched, and sorted by `name` — every taxonomy
target uses it. The Store entry sets `minSelections: 0, maxSelections: 1`
(at most one Store). Brand, Category, and Bank omit both and remain unrestricted
multi-selects. `singularLabel` is separate from the heading `label`, so a future
single-choice Brand/Category/Bank section says “Choose one Brand/Category/Bank”
rather than using its plural heading.

Coupon and Deal share ONE section list (`OFFER_TAXONOMY_SECTIONS`), keyed per
UID from `OFFER_TAXONOMY_UIDS`, and the field names are typed against
`OFFER_TAXONOMY_FIELDS` — the same constant
([`src/constants/offer-taxonomy.ts`](../src/constants/offer-taxonomy.ts)) the
server's `HIDE_FROM_EDIT` uses, so the panel and the hidden default widgets
cannot drift apart. Adding another taxonomy is one entry in the shared list
plus the shared constant; adding another *offer content type* is one UID in
`OFFER_TAXONOMY_UIDS`.

### Form state is a diff, not a list

This is the single most important thing to internalize. For a relation field,
Strapi v5's form state holds `{ connect, disconnect }` command arrays — the
*pending change* — not the current relations. The current list is fetched
separately from the content-manager relations endpoint. Strapi's own widget works
the same way.

Each command mirrors the shape Strapi's built-in relation input produces: a
display-level `{ id, documentId, name }` plus a nested `apiData` object repeating
`id`/`documentId` with a `locale` and, for not-yet-saved additions, an
`isTemporary` marker. Diverging from that shape makes Strapi's save path silently
drop the command. `documentId` — not the numeric `id` — is the identity used
everywhere, since it is the durable v5 identifier; a small helper tolerates
commands that carry it at either level.

### Section behavior

Each `RelationSection` owns its own state and effects, so typing in the Stores
search neither re-renders nor refetches Brands. It subscribes to form state
through a selector scoped to its own field, so edits elsewhere in the form do not
re-render it.

- **Deferred mount.** Nothing fetches until the browser goes idle
  (`requestIdleCallback` with a 1s cap, or a short timeout fallback). The hook is
  called once in the panel body and the signal shared by all sections, so the
  edit view's first paint never competes with the panel's requests.
- **Selected list.** On an existing entry, the panel walks the content-manager
  relations endpoint page by page (bounded) to build the true current list. It
  reads the *latest* form diff through a ref when the fetch resolves and replays
  any pending connects/disconnects on top of the server list, so toggling during
  a slow fetch is never clobbered. Keeping the diff out of the effect's
  dependencies is what stops every toggle from re-running the paginated fetch.
- **Candidates.** Fetched from the content-manager collection-types endpoint,
  30 per page, sorted by `name` ascending, filtered with a `$containsi`
  match on `name` when a search is active. Search input is debounced ~250ms
  and trimmed; changing the query resets the accumulated pages. More pages load
  through an `IntersectionObserver` on a sentinel at the bottom of the fixed-
  height scroll box, rooted on that box rather than the document.
- **Toggling multi-select relations.** Every Brand, Category, and Bank checkbox
  click and every remove-button click goes through one handler that paints
  optimistically, then rewrites the form diff:

  | Server state | Action | `connect` | `disconnect` |
  |---|---|---|---|
  | Not connected | Select | item added | unchanged |
  | Not connected | Select → Deselect | item removed | unchanged |
  | Connected | Deselect | unchanged | item added |
  | Connected | Deselect → Select | unchanged | item removed |

  Clicking an item an even number of times always leaves a clean diff. That
  four-branch idempotency is what makes the panel feel predictable.
- **Choosing a Store.** Store candidates render as a radio group. Choosing a
  Store rebuilds the complete relation diff from the intended one-item result,
  so replacing a persisted Store sends the old disconnect and new connect in
  the same save. The radio remains disabled until an existing record's stored
  relations have loaded; this prevents a fast click from replacing an unknown
  baseline with an incomplete diff.
- **Failure mode.** Both fetches log to the console under `[taxonomy-panel]` and
  leave the section empty rather than throwing; a superseded fetch is dropped via
  a cancellation flag rather than writing stale state.

### Coupon and Deal Store contract

The schemas and document API deliberately keep `stores` as `manyToMany`. Public
responses therefore still return a Store array, migrations and integrations may
still write arrays, and no existing relation is rewritten in bulk. Coupon and
Deal editing through Content Manager allows at most one Store; while Affiliate
brand offer is ON, its separate invariant requires zero Stores.

New entries begin in affiliate mode with Store selection disabled. With the
toggle OFF the panel allows at most one Store: choosing another Store performs
an atomic replacement, and the Store may also be removed in the panel. The
server rejects only a resulting count above one (or any Store while affiliate
mode is ON), with the error attached to `stores`. Brand, Category, and Bank
behavior is unchanged outside the affiliate-only Brand filter described below.

A legacy entry with several Stores displays every current Store plus a cleanup
warning. Merely opening it does not write a form change and never silently
truncates the relation. An editor may remove Stores while more than one remains,
or choose any Store radio to reduce the relation immediately to that Store. The
next Content Manager save is rejected until at most one remains, even if the
editor changed only an unrelated field.

### The Affiliate brand offer toggle

Coupon and Deal carry an `isForAffiliateBrand` boolean whose only edit control
is `AffiliateOfferToggle`, rendered at the top of the Taxonomies panel (the
field is hidden from the main form via `OFFER_PANEL_ONLY_FIELDS`, but stays a
list column). It reuses `BooleanConfirmInput`, so flipping it asks for
confirmation like every other boolean. New Coupons and Deals start with the
toggle ON; changing the schema default does not rewrite existing entries.

- **Enable gate.** Turning OFF is always allowed. Turning ON requires zero
  Stores AND zero Brands currently selected — computed from the live selection
  each `RelationSection` reports upward via its `onSelectedState` prop
  (persisted relations + pending form diff). While an existing entry's
  relations are still loading, the gate counts as blocked.
- **While ON.** The Stores section gets `selectionDisabled` (radios and
  unchecked boxes disabled, select handlers no-op — removal stays enabled so a
  legacy-violating row can be cleaned); the Brands section gets
  `extraCandidateFilters` appending `filters[isAffiliateStore][$eq]=true`, so
  only Brands flagged "Affiliate Store" are listed (multi-select unchanged).
  `logoStore` and `checkoutMerchant` disappear from the main form via native
  schema `conditions.visible` (`!= true`, NULL-safe for legacy rows).
- **Clearing is server-side.** The admin omits conditionally-hidden fields from
  the PUT body, so `normaliseAffiliateOfferFields`
  (`src/utils/affiliate-offer-consistency.ts`, Group A mutator) nulls
  `logoStore`/`checkoutMerchant` whenever a payload carries the toggle as
  `true`. It no-ops when the toggle is absent, so cron/import partial writes
  never clear anything as a side effect.
- **Validation.** `validateAffiliateOfferForWrite` (Group B, CM-gated like the
  one-Store rule) enforces: toggle ON ⇒ zero resulting Stores, every resulting
  Brand flagged `isAffiliateStore`, and no payload-explicit
  `logoStore`/`checkoutMerchant`. `validateAffiliateBrandFlip` (Group B, all
  write origins) blocks un-flagging a Brand while affiliate offers still
  reference it.

---

## 4. The Coupon layout panel (Top Picks and Ordered Coupons)

Entity top-pick and ordered-coupon curation no longer runs through
`RelationSection`: it lives in its own feature,
[`src/admin/features/coupon-layout/`](../src/admin/features/coupon-layout/),
whose `EntityCouponLayoutPanel` renders for the four taxonomy content types —
store, brand, category, bank. Scoped candidate queries (only *this* entity's
live coupons), the save-first notice on unsaved entries, selection caps, and
drag-to-reorder all live there; `RelationSection` itself is now the plain
searchable picker the Taxonomies panel needs and nothing more.

The caps remain UI affordances, not the guarantee. The authoritative check is
server-side in
[`src/utils/entity-top-pick-validation.ts`](../src/utils/entity-top-pick-validation.ts),
run from the document-write middleware
([`src/register/document-write-middleware.ts`](../src/register/document-write-middleware.ts))
on create and update; it re-resolves the resulting relation set and rejects
out-of-range or unrelated selections regardless of how the write arrived.

---

## 5. The Validation problems panel

`ValidationProblemsPanel` runs on every content type. It reads the form's
error state, flattens it, and returns `null` when there is nothing to report — so
it is invisible until a save fails.

The problem it solves: client-side required-field checks and the server-side
validators (homepage image sizes, Deal-of-the-Day section limits, offer word
caps, taxonomy cross-field rules) all deposit errors into the same nested,
per-section error object. Editors saw a generic toast and had to hunt through
every section for the red field.

Its contract:

- **Flattening treats two message shapes as leaves.** Client-side errors are
  react-intl message descriptors; server-side ones are plain strings. A
  descriptor is an object, so the flattener must recognize it as a leaf rather
  than recursing into it.
- **Paths become human locations.** The first path segment is translated through
  the section-label constants for that model (falling back to a de-camel-cased
  field name), later segments are de-camel-cased, and array indices are folded
  into the preceding segment as `#n` — yielding e.g.
  `7 · Fresh Drops › items #2 › card image`.
- **Generic client messages get a size hint.** For homepage media fields, a
  bare "this value is required" is replaced with the exact pixel dimensions
  required, looked up from [`src/constants/homepage-images.ts`](../src/constants/homepage-images.ts).
  Server messages are already specific and are shown as-is.
- **Hook order is model-independent.** The form-state selector runs before the
  applicability check, because a conditional hook would break React's rules when
  the panel mounts on a non-listed model.

---

## 6. Server side — boot-time view config (`src/bootstrap/`)

Lifecycle wiring stays in [`src/index.ts`](../src/index.ts); the routines it
awaits live in [`src/bootstrap/`](../src/bootstrap/)
(`content-manager-layouts.ts`, `field-hints.ts`, `permissions.ts`,
`upload.ts`, `relation-search.ts`, `db-reconciliation.ts`).

### Hiding the panel-owned relations

The panels would be redundant if the default widgets still rendered. On boot,
`hideRelationsFromContentManager`
([`src/bootstrap/content-manager-layouts.ts`](../src/bootstrap/content-manager-layouts.ts))
rewrites the content-manager's stored layout configuration for each entry in
its `HIDE_FROM_EDIT` map — the four taxonomies on deal and coupon (spread from
the shared `OFFER_TAXONOMY_FIELDS` constant the panel config also types
against), and the curated-coupon relations on store, brand, bank, and
category. **Adding a panel means adding its fields here too**, or the widget
and the panel both render.

For each content type it reads the current configuration, drops the hidden cells
from the edit layout (and any row that becomes empty, which would otherwise
render as a visible gap), drops the hidden names from the list layout, and writes
back only if something actually changed. The change check matters — bootstrap
runs on every start and `updateConfiguration` is a database write. Failures are
logged as warnings, never thrown: a cosmetic layout tweak must not stop the
server from booting.

### Content Manager-only Store validation

`validateContentManagerOfferStore` is registered in the collected write-
validation pipeline for Coupon and Deal create, update, and clone actions. It
first confirms that the active Koa request is a Content Manager collection-type
route; background jobs, migrations, custom routes, and public/API integrations
return without a query or restriction.

For updates and clones it loads the stored (or clone-source) `stores` relation,
then resolves direct arrays, `{ set }`, and `{ connect, disconnect }` payloads
to the resulting relation set. A count other than one raises the shared
validation error at path `stores`, so the Validation problems panel points the
editor to the Store section. Loading the stored relation even when `stores` is
absent is intentional: it makes legacy cleanup mandatory on the record's next
admin save without modifying untouched data.

`validateAffiliateOfferForWrite` sits directly after it in the same pipeline
and follows the identical pattern (CM gate, stored-relation re-read, shorthand
resolution) for the affiliate invariant, and `normaliseAffiliateOfferFields` /
`validateAffiliateBrandFlip` complete the trio — see "The Affiliate brand offer
toggle" in §3 and `src/utils/affiliate-offer-consistency.ts`.

### The rest of bootstrap

The awaited bootstrap sequence in [`src/index.ts`](../src/index.ts) runs, in
order: the database reconciliations (`runDatabaseReconciliations` in
[`src/bootstrap/db-reconciliation.ts`](../src/bootstrap/db-reconciliation.ts) —
content contract, site selections, festival category tabs, search indexes,
unique-code integrity), then `initializeSearchRuntime` (pins this process to
ranked PostgreSQL SQL or the query-engine fallback; diagnostics never change
the selected mode), then the view-config routines from `src/bootstrap/`:
layout hiding (§6 above), public-read and single-type permissions, upload and
media-folder settings, relation search fields and readability, entry titles,
field hints and labels, list columns, edit-form widths, and the section labels
for Homepage, Deal of the Day, and the Independence Day sale page. The exact
order is the `await` chain in `index.ts` bootstrap; the
reconciliations-before-search invariant is pinned by
[`src/bootstrap/db-reconciliation.test.ts`](../src/bootstrap/db-reconciliation.test.ts).

Everything here is **config-as-code**: these routines re-apply on every boot, so
changing any of them through the admin UI will not stick across a restart. Edit
the constant or the list in source instead. Bootstrap then checks the production
S3 setting and upload MIME allowlist before starting the ISR outbox dispatcher.

`register` is not empty either — it registers the admin routes
([`src/register/admin-routes.ts`](../src/register/admin-routes.ts)) and
installs the two document-service middlewares: the record-lock guard
([`src/register/record-lock-document.ts`](../src/register/record-lock-document.ts))
followed by the document-write pipeline
([`src/register/document-write-middleware.ts`](../src/register/document-write-middleware.ts)),
which sanitizes richtext, runs the validators, performs the in-transaction
integrity work, and computes durable ISR invalidation scopes. `destroy` stops
the outbox dispatcher.

---

## 7. Verification

1. **Boot.** `yarn develop`. The first boot logs
   `[content-manager] hid relations from …` for each affected type; later boots
   are quiet because the change check short-circuits.
2. **Panels render.** Open a deal or coupon → the right rail shows "Taxonomies"
   with four sections. Open a store, brand, category, or bank → the Coupon
   layout panel (see `docs` for the coupon-layout feature).
3. **Default widgets are gone.** The four taxonomy inputs (and the curated
   coupon relations) must not appear in the main form.
4. **Store round-trip.** Select one Store, save, reload — it persists. Choose a
   different Store, save, reload — only the replacement persists.
5. **Legacy cleanup.** Open a record with multiple Stores: all remain visible
   and no diff is emitted on open. Remove until one remains, or choose one
   radio, then save and reload. An unrelated save before cleanup is rejected at
   `stores`.
6. **Multi-select idempotency.** Select then deselect a Brand, Category, or Bank
   and save: no change server-side.
7. **Debounce and pagination.** With DevTools open, type quickly in a search box
   (requests coalesce, not one per keystroke) and scroll a >30-option list to the
   bottom (a `page=2` request fires).
8. **Race safety.** Throttle the network, open an existing entry, and toggle
   while the initial relations fetch is still in flight — the toggle survives.
9. **Create flow.** On a new deal or coupon the Taxonomies panel works with no
   `documentId`.
10. **Scope and cap.** Covered by the coupon-layout feature's own checks: on a
    store, its curated lists contain only that store's published coupons and
    refuse selections past the cap.
11. **Validation panel.** Save a homepage with a wrong-sized image: the panel
    lists the section path and the exact required pixel dimensions.
12. **Field replacements.** A richtext field opens as a WYSIWYG, a datetime
    picker offers 5-minute steps, and a boolean asks for confirmation. A new
    store's slug is a plain text field that starts empty and offers no
    Regenerate button.
13. **Affiliate toggle default and gate.** On a new Coupon and a new Product
    Deal the toggle sits first in the Taxonomies panel and starts ON. Turn it
    OFF, then select a Store or Brand — it disables with the "untick first"
    hint; remove the selection (unsaved) — it re-enables live. On an existing
    OFF entry with saved Stores/Brands it stays disabled until they are removed.
14. **Affiliate mode.** With the toggle ON, Store radios are disabled with a
    hint, the Brands list shows only Brands flagged "Affiliate Store", and
    `Logo Store` + `Checkout merchant` are absent from the main form. Save,
    reload: the toggle persists and both hidden fields are empty in the
    database. Turn it OFF: everything returns, both fields empty.
15. **Affiliate enforcement.** A CM-route write with the toggle ON and a Store
    is rejected at `stores`; with a non-affiliate Brand at `brands` (named in
    the message). Un-flagging a Brand still referenced by affiliate offers is
    rejected at `isAffiliateStore` with the offer count. A legacy offer with a
    NULL toggle shows both fields (the `!=` condition) and behaves as before.

---

## Further reading

- Strapi's own relation input and relations service (the command shape and
  endpoint this panel mirrors) live under
  `node_modules/@strapi/content-manager/dist/admin/`.
- `PanelComponent`, `PanelDescription`, and `EditViewContext` are exported from
  `@strapi/content-manager/strapi-admin`.
