# Admin Edit-View Customizations

How the Strapi v5 admin bundle is customized: the **Taxonomies** side panel this
file is named after, the two panels that grew beside it, the four replaced field
types, and the server-side bootstrap that keeps the edit view consistent with
them.

> **What this doc is for.** It explains *why* these customizations exist and what
> contract each one holds, so you can change them without re-deriving the intent.
> It is deliberately not a transcription: the maintained references are
> [`src/admin/app.tsx`](../src/admin/app.tsx) (everything client-side) and
> [`src/index.ts`](../src/index.ts) (everything server-side). When this doc and
> the code disagree, the code wins.

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
stepped in 15-minute jumps, booleans flipped on a stray click, and the UID input
seeded new entries with the model name (`store`) as their slug.

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
| [`src/admin/app.tsx`](../src/admin/app.tsx) | The whole admin customization: field-type registrations, admin config/translations, and all three side panels |
| [`src/admin/components/RichTextEditor.tsx`](../src/admin/components/RichTextEditor.tsx) | TipTap WYSIWYG registered for `richtext` |
| [`src/admin/components/DateTimeInput.tsx`](../src/admin/components/DateTimeInput.tsx) | `datetime` picker with 5-minute steps |
| [`src/admin/components/BooleanConfirmInput.tsx`](../src/admin/components/BooleanConfirmInput.tsx) | `boolean` toggle behind a confirmation dialog |
| [`src/admin/components/SlugInput.tsx`](../src/admin/components/SlugInput.tsx) | `uid` input that starts empty and auto-fills from `name` |
| [`src/index.ts`](../src/index.ts) | Server bootstrap: hides the panel-owned relations from the content-manager layout, plus the rest of the boot-time view config |
| [`src/constants/homepage-sections.ts`](../src/constants/homepage-sections.ts), [`src/constants/deal-of-the-day-sections.ts`](../src/constants/deal-of-the-day-sections.ts), [`src/constants/homepage-images.ts`](../src/constants/homepage-images.ts) | Section labels and image size rules shared by the admin bundle and the server |

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
| `uid` | `SlugInput` | Starts empty instead of seeding the model's singular name, auto-fills from `name` until hand-edited, and offers a "Regenerate" button. Trades away Strapi's live availability indicator — uniqueness is still enforced by the schema on save. |

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

Registers all three panels in one `addEditViewSidePanel` call on the
content-manager plugin's `apis` object, in order: Taxonomies, Top Pick Coupons,
Validation problems. Each panel decides for itself whether it applies to the
current model (§3–§5), so registration is unconditional.

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
  field: string;                  // attribute name on the parent (form key)
  target: string;                 // related content-type UID
  label: string;                  // heading + search placeholder
  mainField?: 'name' | 'title';   // label/search/sort attribute; defaults to 'name'
  scopeRelationField?: 'stores' | 'brands' | 'categories' | 'banks';
  minSelections?: number;
  maxSelections?: number;
};
```

The Coupon and Deal Store entries set `minSelections: 1` and
`maxSelections: 1`. Their sibling Brand, Category, and Bank entries omit both
and remain unrestricted multi-selects. The other optional members support
bounded or scoped uses of the shared relation-section implementation. Adding
another taxonomy to deals is one entry; adding another *content type* to the
Taxonomies panel is one more top-level key in `RELATION_CONFIG`.

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
  30 per page, sorted by `mainField` ascending, filtered with a `$containsi`
  match on `mainField` when a search is active. Search input is debounced ~250ms
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
still write arrays, and no existing relation is rewritten in bulk. The stricter
rule belongs only to Coupon and Deal editing through Content Manager: the
resulting selection must contain exactly one Store.

New entries begin with a visible “Select exactly one Store” notice. Once one is
selected, its remove button is disabled; choosing another Store performs an
atomic replacement. Brand, Category, and Bank behavior is unchanged.

A legacy entry with several Stores displays every current Store plus a cleanup
warning. Merely opening it does not write a form change and never silently
truncates the relation. An editor may remove Stores while more than one remains,
or choose any Store radio to reduce the relation immediately to that Store. The
next Content Manager save is rejected until exactly one remains, even if the
editor changed only an unrelated field.

---

## 4. The Top Pick Coupons panel

`EntityTopPickCouponPanel` renders for the four taxonomy content types — store,
brand, category, bank — driven by `ENTITY_TOP_PICK_CONFIG`. Each entry points at
the entity's `topPickCoupons` relation, targets coupons, labels them by `title`,
and sets a 2–4 selection range plus the `scopeRelationField` naming the inverse
relation back to this entity type.

It reuses `RelationSection` unchanged. The extra config members change its
behavior in four visible ways:

- **Scoped candidates.** With `scopeRelationField` set, the candidate query is
  filtered to coupons related to *this* entity and to `contentStatus=published`.
  An editor picking store top-picks only ever sees that store's live coupons.
- **Requires a saved entity.** Scoping needs a `documentId`, so on a brand-new
  entry the panel renders "Save this entry first" instead of an unusable list.
- **Hard cap.** The heading shows `n/max`, unselected checkboxes disable once the
  maximum is reached, and the toggle handler refuses additions past it.
- **Explanatory copy.** The panel states the selection range and how the picks
  are consumed (first two shown live, the next two as expiry buffers, clearing
  all falls back to the latest two).

The cap is a UI affordance, not the guarantee. The authoritative check is
server-side in
[`src/utils/entity-top-pick-validation.ts`](../src/utils/entity-top-pick-validation.ts),
run from the documents middleware in [`src/index.ts`](../src/index.ts) on create
and update; it re-resolves the resulting relation set and rejects out-of-range or
unrelated selections regardless of how the write arrived.

---

## 5. The Validation problems panel

`ValidationProblemsPanel` applies to the homepage and Deal-of-the-Day single
types plus coupon, deal, store, category, bank, and brand. It reads the form's
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

## 6. Server side — `src/index.ts`

### Hiding the panel-owned relations

The panels would be redundant if the default widgets still rendered. On boot,
`hideRelationsFromContentManager` rewrites the content-manager's stored layout
configuration for each entry in its `HIDE_FROM_EDIT` map — the four taxonomies on
deal and coupon, and `topPickCoupons` on store, brand, bank, and category. Note
this map is the server-side twin of the admin bundle's `RELATION_CONFIG` and
`ENTITY_TOP_PICK_CONFIG`: **adding a panel means adding its fields here too**, or
the widget and the panel both render.

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

### The rest of bootstrap

The search/index integrity checks plus layout hiding are part of the awaited
bootstrap sequence. The full sequence, in order:

1. **`reconcileSearchIndexesAfterSchemaSync`** — on PostgreSQL, structurally
   checks and best-effort repairs all expected search indexes after schema sync.
   Healthy indexes are left untouched; DDL failures are logged and retried on
   the next boot without blocking Strapi.
2. **`reconcileUniqueCodeIntegrityAfterSchemaSync`** — verifies the
   database-level unique-code constraints after schema synchronization.
3. **`initializeSearchRuntime`** — reads the configured database dialect and
   pins this process to ranked SQL (PostgreSQL) or the full-set query-engine
   fallback. On PostgreSQL it separately resolves the Strapi table schema and
   inspects `pg_trgm` plus structural index health; diagnostics never change the
   selected mode. Fixed per process; changing it requires a restart.
4. **`hideRelationsFromContentManager`** — above.
5. **`ensurePublicReadPermissions`** — grants the public role read access to the
   taxonomy collections and the four site-content single types.
6. **`restrictSingleTypesToSuperAdmin`** — strips content-manager permissions for
   Footer and Global Settings from every non-super-admin role.
7. **`ensureUploadSettings`** — turns on size optimization, responsive
   dimensions, and auto-orientation in the Media Library settings.
8. **`ensureComponentEntryTitles`** — pins the collapsed-row label field for each
   repeatable component.
9. **`ensureComponentFieldDescriptions`** — writes the help text under each
   size-enforced homepage media field, derived from the same image rules the
   validator and the Validation problems panel use.
10. **`ensureFieldDescriptions`** — applies maintained help text to ordinary
    content fields.
11. **`ensureSingleTypeEntryTitles`** — pins single types' header label to
    `title` instead of the opaque migrated document ID.
12. **`ensureOfferListStatusColumn`** — appends `contentStatus` to the Coupon and
   Deal list views so editors can see and filter expired offers.
13. **`ensureSortableListColumns`** — pins list columns that support maintained
    sorting behavior.
14. **`ensureFullWidthEditFields`** — applies the maintained edit-form widths.
15. **`ensureSectionLabels`** — pins section labels, help text, and edit-form
    order from the shared section constants for Homepage and Deal of the Day.

Everything here is **config-as-code**: these routines re-apply on every boot, so
changing any of them through the admin UI will not stick across a restart. Edit
the constant or the list in source instead. Bootstrap then checks the production
S3 setting and upload MIME allowlist before starting the ISR outbox dispatcher.

`register` is not empty either — it installs the documents middleware that
sanitizes richtext, runs the validators, invalidates offer-redeem caches, and
computes durable ISR invalidation scopes. `destroy` stops the outbox dispatcher.

---

## 7. Verification

1. **Boot.** `yarn develop`. The first boot logs
   `[content-manager] hid relations from …` for each affected type; later boots
   are quiet because the change check short-circuits.
2. **Panels render.** Open a deal or coupon → the right rail shows "Taxonomies"
   with four sections. Open a store, brand, category, or bank → "Top Pick
   Coupons".
3. **Default widgets are gone.** The four taxonomy inputs (and `topPickCoupons`)
   must not appear in the main form.
4. **Store round-trip.** Select one Store, save, reload — it persists. Choose a
   different Store, save, reload — only the replacement persists. The final
   Store's remove button stays disabled.
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
   `documentId`. On a new store the Top Pick panel shows the "save first" notice.
10. **Scope and cap.** On a store, the Top Pick list contains only that store's
   published coupons, and a fifth selection is refused.
11. **Validation panel.** Save a homepage with a wrong-sized image: the panel
    lists the section path and the exact required pixel dimensions.
12. **Field replacements.** A richtext field opens as a WYSIWYG, a datetime
    picker offers 5-minute steps, a boolean asks for confirmation, and a new
    store's slug starts empty rather than reading `store`.

---

## Further reading

- Strapi's own relation input and relations service (the command shape and
  endpoint this panel mirrors) live under
  `node_modules/@strapi/content-manager/dist/admin/`.
- `PanelComponent`, `PanelDescription`, and `EditViewContext` are exported from
  `@strapi/content-manager/strapi-admin`.
