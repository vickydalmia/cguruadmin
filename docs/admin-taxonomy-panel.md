# Admin Taxonomy Side Panel — Line-by-Line Reference

A deep walkthrough of the custom Strapi v5 admin side panel we built for managing taxonomy relations (`stores`, `brands`, `categories`, `banks`, `tags`) on the `deal` and `coupon` content types.

---

## 1. Overview

### Problem

Strapi v5's default relation widget fetches relation options one small batch at a time and renders a dropdown. When the target collection is large (we have thousands of stores and brands), this UX becomes painful:

- Scrolling the dropdown is sluggish.
- Finding an item by name is awkward.
- Bulk selecting multiple items requires many round trips.
- Every relation field in the main form gets its own widget, and a deal/coupon has five of them — the edit view becomes noisy.

### Solution

1. Build a **custom side panel** ("Taxonomies") that renders a compact checkbox + selected-chip UI for all five relations in one place, with search, pagination, and infinite scroll.
2. **Hide the default relation widgets** for those five fields from the edit view, so nothing is duplicated and the main form stays clean.

### Files

| File | Purpose |
|------|---------|
| `src/admin/app.tsx` | The panel UI — React component, fetch logic, form integration |
| `src/index.ts` | Server bootstrap hook that rewrites the content-manager layout to hide those relations |

---

## 2. Entry Point — `app.tsx` default export (lines 461–469)

```tsx
export default {
  config: {
    locales: [],
  },
  bootstrap(app: StrapiApp) {
    const apis = (app.getPlugin('content-manager') as any).apis;
    apis.addEditViewSidePanel([RelationMultiSelectPanel]);
  },
};
```

- **`config.locales: []`** — Required field in Strapi's admin customization contract. Empty array because we're not adding locales; Strapi would warn at boot if the key were missing.
- **`bootstrap(app: StrapiApp)`** — Strapi calls this once, after the admin JS bundle loads but before the UI renders. It's the hook for registering injection zones, plugins, and side panels.
- **`app.getPlugin('content-manager')`** — Returns the content-manager plugin instance.
- **`.apis`** — The mutation API for the content manager (add side panels, bulk actions, document actions, header actions). We cast to `any` because `getPlugin` is typed loosely and `.apis` isn't on the public surface; the plugin's `ContentManagerPlugin` class (`node_modules/@strapi/content-manager/.../content-manager.d.ts`) exposes `addEditViewSidePanel` on `.config.apis` but the runtime shape is what we hit here.
- **`addEditViewSidePanel([RelationMultiSelectPanel])`** — Registers our panel. The array form is the static-registration path; the alternative (reducer function) lets you reorder existing panels, which we don't need.

---

## 3. Panel Component Contract — `RelationMultiSelectPanel` (lines 452–459)

```tsx
const RelationMultiSelectPanel: PanelComponent = ({ model, documentId }) => {
  if (!RELATION_CONFIG[model]) return null;

  return {
    title: 'Taxonomies',
    content: <PanelBody model={model} documentId={documentId} />,
  };
};
```

- **`PanelComponent`** — Imported from `@strapi/content-manager/strapi-admin`. Defined as `DescriptionComponent<PanelComponentProps, PanelDescription>`. Props are `EditViewContext`, which includes `activeTab`, `collectionType`, `document`, `documentId`, `meta`, and `model`.
- **Early return `null`** — When the current content type isn't in `RELATION_CONFIG` (e.g. a blog post), we return `null` so Strapi skips rendering this panel. Without this guard the panel would try to render for every content type and crash on the missing config.
- **Return shape `{ title, content }`** — This is **not JSX**. `PanelComponent` returns a `PanelDescription` object — a data description Strapi uses to render the actual `<Panel>` chrome. The `content` field is where JSX lives. First-time plugin authors often return JSX directly and get a cryptic error; the `PanelComponent` type is what steers us to the right shape.
- **`title: 'Taxonomies'`** — The section heading shown in the side rail.
- **`content: <PanelBody ... />`** — Our actual component tree.

---

## 4. Declarative Relation Config (lines 17–38)

```tsx
type RelationConfig = {
  field: string;
  target: string;
  label: string;
};

const RELATION_CONFIG: Record<string, RelationConfig[]> = {
  'api::deal.deal': [
    { field: 'stores', target: 'api::store.store', label: 'Stores' },
    { field: 'brands', target: 'api::brand.brand', label: 'Brands' },
    { field: 'categories', target: 'api::category.category', label: 'Categories' },
    { field: 'banks', target: 'api::bank.bank', label: 'Banks' },
    { field: 'tags', target: 'api::tag.tag', label: 'Tags' },
  ],
  'api::coupon.coupon': [
    /* same five */
  ],
};
```

- **`field`** — the attribute name on the parent content type (matches the form key).
- **`target`** — the related content type's UID (used to build the candidate-list URL).
- **`label`** — display name in the panel heading and search placeholder.
- Keyed by content-type UID. Adding a new taxonomy to deals is a one-line change. Adding a third content type (e.g. a promotional banner) is just a new top-level key.
- Both `deal` and `coupon` share the same five relations because they share the same taxonomy model.

---

## 5. Type Model for Relation Commands (lines 40–52)

```tsx
type Candidate = { id: number; documentId: string; name: string };
type RelationCommand = Candidate & {
  apiData: {
    id: number;
    documentId: string;
    locale: string | null;
    isTemporary?: boolean;
  };
};
type RelationFormValue = {
  connect?: RelationCommand[];
  disconnect?: RelationCommand[];
};
```

Three distinct shapes, each for a specific purpose:

- **`Candidate`** — the minimal info we need in UI state: the numeric `id` (for React keys / some legacy paths), the `documentId` (canonical v5 identifier), and a display `name`. That's all the UI ever shows.
- **`RelationCommand`** — what Strapi v5's form state expects when you push an entry into `connect` or `disconnect`. It extends `Candidate` with an `apiData` nested object. This shape mirrors Strapi's own `handleConnect` at `node_modules/@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs:186-192` and `handleDisconnect` at `:47-54`. If you diverge from this shape, Strapi's save path silently drops the command.
  - `apiData.id` / `apiData.documentId` — repeated inside for Strapi's internal serializer.
  - `apiData.locale: string | null` — added defensively. Strapi includes it in its own commands; if i18n is later enabled on these targets, omitting it would route connects to the wrong locale.
  - `apiData.isTemporary?: true` — marks a connect that hasn't been saved yet. Strapi uses this to grey out the chip in its default UI; in our panel it's cosmetic for Strapi but required for parity.
- **`RelationFormValue`** — what `useForm` exposes for a relation field: **a diff**, not the current list. This is the single most important thing to internalize about Strapi v5 relation forms.
  - `connect[]` — commands to add.
  - `disconnect[]` — commands to remove.
  - The actual current list is fetched separately (via `/content-manager/relations/...`). Strapi's own default widget also does this — it keeps a server-sourced list in RTK Query cache and shows `connect`/`disconnect` on top of it.

### Type Guard (lines 56–62)

```tsx
const isRelationFormValue = (value: unknown): value is RelationFormValue =>
  Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ('connect' in value || 'disconnect' in value)
  );
```

Distinguishes the diff shape from a legacy array-of-current-values shape. Even though v5 should always hand us the diff, being explicit here gives us a fall-through path (see §10c Branch A).

---

## 6. Identity Helper — `getRelationDocumentId` (lines 64–65)

```tsx
const getRelationDocumentId = (relation: any): string | undefined =>
  relation?.apiData?.documentId ?? relation?.documentId;
```

- **Why `documentId` over `id`** — In Strapi v5, `documentId` (a stable CUID) is the canonical identifier. The numeric `id` is still returned but represents a specific row in a specific locale and isn't durable across migrations/environments.
- **Fallback chain** — Commands from `toRelationCommand` have `apiData.documentId` *and* a top-level `documentId`. Commands from Strapi's own code paths sometimes only have one or the other. The `??` chain tolerates both.

---

## 7. Command Factory — `toRelationCommand` (lines 67–80)

```tsx
const toRelationCommand = (
  candidate: Candidate,
  options: { isTemporary?: boolean } = {}
): RelationCommand => ({
  id: candidate.id,
  documentId: candidate.documentId,
  name: candidate.name,
  apiData: {
    id: candidate.id,
    documentId: candidate.documentId,
    locale: null,
    ...(options.isTemporary ? { isTemporary: true } : {}),
  },
});
```

- Single function that produces both `connect` and `disconnect` commands.
- `isTemporary: true` is set only for connects of brand-new selections (see `toggle` at §10i). Disconnects never get `isTemporary` — they refer to items that already exist on the server.
- `locale: null` is unconditional. If this project adopts i18n for taxonomies later, swap this for the document's active locale.

---

## 8. Deferred Mount Hook — `useDeferredMount` (lines 82–94)

```tsx
function useDeferredMount(): boolean {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const w = window as any;
    if (typeof w.requestIdleCallback === 'function') {
      const id = w.requestIdleCallback(() => setReady(true), { timeout: 1000 });
      return () => w.cancelIdleCallback?.(id);
    }
    const id = setTimeout(() => setReady(true), 400);
    return () => clearTimeout(id);
  }, []);
  return ready;
}
```

- **Problem solved** — Side panels mount with the rest of the edit view. If all five sections kicked off network requests on first render, the first paint of the edit view would compete with 10+ XHRs (one for the current relation list plus one for candidates, per section).
- **Strategy** — Return `false` immediately, flip to `true` when the browser is idle (or after a 400 ms fallback timeout for browsers without `requestIdleCallback`, notably older Safari).
- **`timeout: 1000`** — cap the idle wait at 1 second so slow devices don't get stuck showing an empty panel forever.
- Every data-fetch `useEffect` in `RelationSection` guards on `if (!deferred) return`, so the whole network flurry is deferred until the main form is interactive.
- Cleanup cancels the pending idle callback / timeout if the component unmounts first.

---

## 9. `PanelBody` — Per-Model Section Layout (lines 427–450)

```tsx
function PanelBody({ model, documentId }: { model: string; documentId?: string }) {
  const deferred = useDeferredMount();
  return (
    <Box width="100%">
      {RELATION_CONFIG[model].map((cfg, idx) => (
        <React.Fragment key={cfg.field}>
          {idx > 0 ? <Divider /> : null}
          <RelationSection
            config={cfg}
            deferred={deferred}
            model={model}
            documentId={documentId}
          />
        </React.Fragment>
      ))}
    </Box>
  );
}
```

- `useDeferredMount` is called **once** here (not inside each `RelationSection`). All five sections share the same `deferred` signal, so we spend only one idle slot instead of five.
- `<Divider />` between sections — not before the first.
- `key={cfg.field}` is stable because `config.field` is a constant string per relation.
- `documentId` is forwarded. When undefined (creating a new entry), the selected-fetch effect inside `RelationSection` silently skips; only the candidate-list fetch runs.

---

## 10. `RelationSection` — The Heart of the Panel

Signature (lines 96–106):

```tsx
function RelationSection({
  config,
  deferred,
  model,
  documentId,
}: {
  config: RelationConfig;
  deferred: boolean;
  model: string;
  documentId?: string;
}) { /* ... */ }
```

### 10a. Form Integration (lines 107–113)

```tsx
const { get } = useFetchClient();

const formValue = useForm(
  'RelationSection',
  (state) => state.values?.[config.field]
);
const onChangeForm = useForm('RelationSection', (state) => state.onChange);
```

- **`useFetchClient()`** — Strapi's auth-aware fetch wrapper. The returned `get` automatically attaches the admin JWT and base URL. We use it for both the candidate list and the existing-relations list.
- **`useForm('RelationSection', selector)`** — Strapi's form state hook. The string is a consumer name used in error messages if the hook is called outside a `FormProvider`. The selector is key: `useForm` only re-renders this component when the **selected slice** changes. We subscribe to `state.values?.[config.field]` — the form state slot for *this* relation only. Edits to `title`, `content`, other relations, etc. do not re-render this section.
- **Second call for `onChange`** — Again with a selector, so the dispatcher reference is stable and we don't pay for re-renders when unrelated form state mutates.

### 10b. State Inventory

| Name | Line | Purpose |
|------|------|---------|
| `selectedList` | 115 | Denormalized list of currently-selected items. Drives the chip strip and the `checked` prop on checkboxes. |
| `formValueRef` | 117 | Latest `formValue` mirrored for async fetches to read (avoids stale closures). |
| `candidates` | 231 | Current page(s) of available options loaded from the server. |
| `page` / `pageCount` | 232–233 | Infinite-scroll pagination cursor. |
| `loading` | 234 | Shows the `Loader` while a page is in-flight. |
| `initialLoaded` | 235 | Tracks whether the first page completed so we can show either a loading spinner or an empty-state message. |
| `search` / `debouncedSearch` | 236–237 | Live text input + its 250 ms debounced mirror. |
| `sentinelRef` | 340 | The 1px `<div>` at the bottom of the scroll container that the IntersectionObserver watches. |

### 10c. Form → Local State Sync Effect (lines 122–165)

```tsx
React.useEffect(() => {
  if (Array.isArray(formValue) && formValue.length > 0) {
    setSelectedList(
      formValue.map((v: any) => ({
        id: v.id,
        documentId: v.documentId,
        name: v.name ?? v.title ?? String(v.id),
      }))
    );
    return;
  }

  if (isRelationFormValue(formValue)) {
    setSelectedList((current) => {
      const disconnectDocIds = new Set(
        (formValue.disconnect ?? [])
          .map((relation) => getRelationDocumentId(relation))
          .filter((docId): docId is string => Boolean(docId))
      );
      const next = current.filter(
        (relation) => !disconnectDocIds.has(relation.documentId)
      );

      for (const relation of formValue.connect ?? []) {
        const docId = getRelationDocumentId(relation);
        if (
          !docId ||
          disconnectDocIds.has(docId) ||
          next.some((item) => item.documentId === docId)
        ) {
          continue;
        }
        next.push({
          id: relation.id,
          documentId: docId,
          name: relation.name ?? String(relation.id),
        });
      }

      return next;
    });
  }
}, [formValue]);
```

Two branches cover two possible `formValue` shapes:

**Branch A — legacy array (lines 123–132).** Rare in Strapi v5 (the form stores diffs, not arrays), but if some code path hydrates the form with a pre-populated array, we handle it by mapping straight into `Candidate`. The `name ?? title ?? String(id)` fallback covers both `name`-keyed taxonomies and `title`-keyed ones.

**Branch B — diff shape (lines 134–164).** The common case. We reconcile the diff on top of current `selectedList`:

1. **Build `disconnectDocIds` Set** — a lookup of pending disconnects. `.filter((docId): docId is string => Boolean(docId))` narrows the type so the Set contains only strings.
2. **Filter current** — remove any item the user has queued for disconnection.
3. **Walk `connect[]`** — for each:
   - Skip if we can't determine a `documentId`.
   - Skip if this docId is in `disconnectDocIds` (net-zero: connect + disconnect cancel each other).
   - Skip if it's already in `next` (prevents double-add when the `toggle` handler already did an optimistic insert).
   - Otherwise push a lightweight `Candidate`.

**Why functional setter.** `setSelectedList((current) => ...)` reads the truly-latest `current`, so even when React batches `setSelectedList(next)` + `onChangeForm(...)` from the `toggle` handler, this effect doesn't reset state.

**Dependency `[formValue]`.** Every form diff retriggers this. Since `selectedList` updates inside the setter use the latest `current`, this is O(|connect| + |disconnect|) per edit.

### 10d. `formValueRef` Mirror (lines 117–120)

```tsx
const formValueRef = React.useRef(formValue);
React.useEffect(() => {
  formValueRef.current = formValue;
}, [formValue]);
```

- **Why a ref?** The initial-selected-relations fetch (§10f) runs async. When it resolves, the `formValue` captured in its closure is stale. Adding `formValue` to its dep array would re-fire the entire paginated fetch on every edit — a waste. Instead we capture a ref.
- The effect is a one-liner that keeps `.current` in lockstep with the subscribed value.

### 10e. Debounced Search (lines 239–242)

```tsx
React.useEffect(() => {
  const t = setTimeout(() => setDebouncedSearch(search.trim()), 250);
  return () => clearTimeout(t);
}, [search]);
```

- Every keystroke rewrites the pending timeout; only the last one survives the 250 ms quiet window.
- Only `debouncedSearch` enters the fetch effect's dep list, so API calls don't fire per keystroke.
- `.trim()` prevents `" tag "` from becoming a distinct search (network-redundant).

### 10f. Initial Selected-Relations Fetch (lines 167–224)

The asymmetric-important effect. Runs once per `(deferred, documentId, model, config.field, get)` tuple:

```tsx
React.useEffect(() => {
  if (!deferred || !documentId) return;
  let cancelled = false;
  const run = async () => {
    try {
      const all: Candidate[] = [];
      for (let page = 1; page <= 50; page++) {
        const res = await get(
          `/content-manager/relations/${model}/${documentId}/${config.field}?page=${page}&pageSize=100`
        );
        const body = res?.data?.data ?? res?.data;
        const results: any[] = body?.results ?? [];
        all.push(
          ...results.map((r: any) => ({
            id: r.id,
            documentId: r.documentId,
            name: r.name ?? r.title ?? String(r.id),
          }))
        );
        const pageCount = body?.pagination?.pageCount ?? 1;
        if (page >= pageCount || results.length === 0) break;
      }
      if (cancelled) return;
      setSelectedList(() => {
        const latest = formValueRef.current;
        if (!isRelationFormValue(latest)) return all;
        /* ...reconcile disconnect/connect on top of `all`... */
      });
    } catch (err) {
      console.error(`[taxonomy-panel] Failed to load selected ${config.field}`, err);
    }
  };
  run();
  return () => { cancelled = true; };
}, [deferred, documentId, model, config.field, get]);
```

- **Gate** — skip if not yet idle, or if there's no `documentId` (create flow: nothing is persisted yet, so there's nothing to fetch).
- **`cancelled` flag + cleanup** — the cleanup sets `cancelled = true`; in-flight fetches check this before touching state. Prevents "Can't perform a React state update on an unmounted component" warnings and stale writes after deps change.
- **Paginated loop** — up to 50 pages × 100 rows = 5000 selected items max. Early exit when `page >= pageCount` or we get an empty page.
- **Endpoint** — `/content-manager/relations/{model}/{documentId}/{field}`. Confirmed against Strapi v5 source at `node_modules/@strapi/content-manager/dist/admin/services/relations.mjs:9`. In v5 the URL path uses `documentId`, **not** numeric id — this is a critical v4→v5 difference.
- **`body = res?.data?.data ?? res?.data`** — tolerates both the plain and wrapped envelope shapes Strapi occasionally returns.
- **Mapping** — `name ?? title ?? String(id)` fallback for targets with non-standard label fields.
- **Race-safe apply** — after the await, we `setSelectedList(() => ...)` with a functional setter that reads `formValueRef.current`. If the user toggled anything while the fetch was in flight, we replay those pending `connect`/`disconnect` operations on top of the server list instead of clobbering them. Without this, a fast clicker could lose their selection.
- **Why `formValue` is NOT a dep** — if it were, every toggle would re-fire the paginated fetch. We use the ref so this effect runs only when structural inputs change.

### 10g. Candidate-List Reset Effect (lines 244–249)

```tsx
React.useEffect(() => {
  setCandidates([]);
  setPage(1);
  setPageCount(1);
  setInitialLoaded(false);
}, [debouncedSearch, config.target]);
```

- When the user changes the search query (or the target config changes), discard the cached pages so they don't mix with the new query's results.
- Runs *before* the fetch effect below (React orders effects by declaration), so by the time the fetch fires, state is clean.

### 10h. Candidate Fetch Effect (lines 251–284)

```tsx
React.useEffect(() => {
  if (!deferred) return;
  let cancelled = false;
  const run = async () => {
    setLoading(true);
    try {
      const searchParam = debouncedSearch
        ? `&filters[name][$containsi]=${encodeURIComponent(debouncedSearch)}`
        : '';
      const res = await get(
        `/content-manager/collection-types/${config.target}?page=${page}&pageSize=${PAGE_SIZE}&sort=name:ASC${searchParam}`
      );
      const body = res?.data?.data ?? res?.data;
      const results: any[] = body?.results ?? [];
      if (cancelled) return;
      const list: Candidate[] = results.map((r: any) => ({
        id: r.id,
        documentId: r.documentId,
        name: r.name ?? r.title ?? String(r.id),
      }));
      setCandidates((prev) => (page === 1 ? list : [...prev, ...list]));
      setPageCount(body?.pagination?.pageCount ?? 1);
      setInitialLoaded(true);
    } catch (err) {
      console.error(`[taxonomy-panel] Failed to load ${config.field}`, err);
    } finally {
      if (!cancelled) setLoading(false);
    }
  };
  run();
  return () => { cancelled = true; };
}, [deferred, page, debouncedSearch, config.target, config.field, get]);
```

- **Endpoint** — `/content-manager/collection-types/{uid}`. Returns paginated entries with a `pagination.pageCount` hint.
- **Search** — `filters[name][$containsi]=<query>` (case-insensitive substring). All five taxonomies have a `name: string` attribute, so this works uniformly.
- **Sort** — `name:ASC`. Alphabetical is intuitive and stable.
- **`PAGE_SIZE = 30`** (line 54). Small enough for quick first paint, large enough that a typical search fits on one page.
- **Append vs replace** — `page === 1 ? list : [...prev, ...list]`. The observer increments `page` to load more; page 1 after a search change replaces the cache.
- **`pageCount`** drives `hasMore` (line 341) which in turn drives the observer.
- **`initialLoaded: true`** — switches the empty-state copy from nothing to "No matches" / "No {label} available".
- **`finally` clears `loading`** only if not cancelled (we don't want to setState on an unmounted component).

### 10i. Toggle Handler (lines 286–338)

The single function that writes back to Strapi's form. Every checkbox click and every chip-close routes through here.

```tsx
const toggle = (c: Candidate) => {
  const exists = selectedList.some((s) => s.documentId === c.documentId);
  const next = exists
    ? selectedList.filter((s) => s.documentId !== c.documentId)
    : [...selectedList, c];
  const currentValue = isRelationFormValue(formValue) ? formValue : {};
  const currentConnect = currentValue.connect ?? [];
  const currentDisconnect = currentValue.disconnect ?? [];

  setSelectedList(next);

  if (exists) {
    /* unselect branch */
  } else {
    /* select branch */
  }
};
```

**Preamble (lines 287–295):**
- `exists` — is the candidate currently in `selectedList`? (Matched by `documentId`.)
- `next` — the optimistic new `selectedList`.
- `currentValue / currentConnect / currentDisconnect` — read the form's current pending diff.
- `setSelectedList(next)` — **paint first**. Instant feedback; the form state catches up below.

**Unselect branch (lines 297–316):**
```tsx
const wasOnlyPendingConnect = currentConnect.some(
  (relation) => getRelationDocumentId(relation) === c.documentId
);

onChangeForm(config.field, {
  connect: currentConnect.filter(
    (relation) => getRelationDocumentId(relation) !== c.documentId
  ),
  disconnect: wasOnlyPendingConnect
    ? currentDisconnect
    : [
        ...currentDisconnect.filter(
          (relation) => getRelationDocumentId(relation) !== c.documentId
        ),
        toRelationCommand(c),
      ],
});
```
- `wasOnlyPendingConnect` — was this item added earlier in this session but not yet saved?
- Always strip the item from `connect`.
- If it was an unsaved addition, don't push a disconnect either — the net effect should be zero. Otherwise push a new disconnect command.

**Select branch (lines 319–337):**
```tsx
const wasPendingDisconnect = currentDisconnect.some(
  (relation) => getRelationDocumentId(relation) === c.documentId
);

onChangeForm(config.field, {
  connect: wasPendingDisconnect
    ? currentConnect.filter(
        (relation) => getRelationDocumentId(relation) !== c.documentId
      )
    : [
        ...currentConnect.filter(
          (relation) => getRelationDocumentId(relation) !== c.documentId
        ),
        toRelationCommand(c, { isTemporary: true }),
      ],
  disconnect: currentDisconnect.filter(
    (relation) => getRelationDocumentId(relation) !== c.documentId
  ),
});
```
- `wasPendingDisconnect` — did the user remove this item earlier in this session?
- If yes, just cancel the disconnect (don't add a connect; the item was never gone server-side).
- If no, push a new `isTemporary: true` connect.
- Always strip the item from `disconnect`.

### Truth Table

| Starting server state | User action | Result in `connect` | Result in `disconnect` |
|------|------|------|------|
| Not connected | Select | `[..., X]` | (unchanged) |
| Not connected | Select → Deselect | (removed) | (unchanged) |
| Connected | Deselect | (unchanged) | `[..., X]` |
| Connected | Deselect → Select | (unchanged) | (removed) |

This four-branch idempotency is what makes the UI feel predictable: clicking an item an even number of times always leaves the form in a clean diff state.

### 10j. Infinite Scroll Observer (lines 343–356)

```tsx
const sentinelRef = React.useRef<HTMLDivElement>(null);
const hasMore = page < pageCount;

React.useEffect(() => {
  const el = sentinelRef.current;
  if (!el || !hasMore || loading) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        setPage((p) => p + 1);
      }
    },
    { root: el.parentElement, rootMargin: '50px' }
  );
  observer.observe(el);
  return () => observer.disconnect();
}, [hasMore, loading, candidates.length]);
```

- `sentinelRef` points at the 1px div at the bottom of the scroll container (line 421 in the render tree).
- `root: el.parentElement` — observe intersection relative to the scroll container (`maxHeight: 220; overflow-y: auto`), not the whole document.
- `rootMargin: '50px'` — start fetching 50px before the sentinel enters the viewport.
- Early exits:
  - `!el` — ref not yet attached (first render).
  - `!hasMore` — we're on the last page; nothing to fetch.
  - `loading` — don't trigger a second fetch while one is in flight.
- `setPage((p) => p + 1)` — functional setter safe against stale closures.
- **Dep list** — `[hasMore, loading, candidates.length]`. `candidates.length` is included because as new rows render, the sentinel's position shifts; we need to re-observe against the updated layout.
- Cleanup `.disconnect()` — on every dep change or unmount.

### 10k. Render Tree (lines 358–424)

```tsx
return (
  <Box paddingTop={3} paddingBottom={3} width="100%">
    <Flex justifyContent="space-between" alignItems="center" paddingBottom={2}>
      <Typography variant="sigma" textColor="neutral600">
        {config.label} ({selectedList.length})
      </Typography>
    </Flex>

    {selectedList.length > 0 ? (
      <Box paddingBottom={2} width="100%">
        <Flex gap={1} wrap="wrap">
          {selectedList.map((c) => (
            <Tag key={c.documentId} icon={<Cross />} onClick={() => toggle(c)}>
              {c.name}
            </Tag>
          ))}
        </Flex>
      </Box>
    ) : null}

    <Box paddingBottom={2} width="100%">
      <TextInput
        aria-label={`Search ${config.label}`}
        placeholder={`Search ${config.label.toLowerCase()}...`}
        value={search}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
        size="S"
      />
    </Box>

    <Box
      hasRadius
      background="neutral0"
      borderColor="neutral200"
      padding={2}
      width="100%"
      style={{ maxHeight: 220, overflowY: 'auto', boxSizing: 'border-box' }}
    >
      {candidates.map((c) => (
        <Box key={c.documentId} paddingBottom={1}>
          <Checkbox
            checked={selectedDocIds.has(c.documentId)}
            onCheckedChange={() => toggle(c)}
          >
            {c.name}
          </Checkbox>
        </Box>
      ))}

      {initialLoaded && candidates.length === 0 ? (
        <Typography variant="pi" textColor="neutral500">
          {debouncedSearch ? 'No matches.' : `No ${config.label.toLowerCase()} available.`}
        </Typography>
      ) : null}

      {loading ? (
        <Flex justifyContent="center" padding={2}>
          <Loader small>Loading</Loader>
        </Flex>
      ) : null}

      <div ref={sentinelRef} style={{ height: 1 }} />
    </Box>
  </Box>
);
```

Four visual layers, top to bottom:

1. **Header row** — `Typography variant="sigma"` (Strapi's small-caps heading style) showing `{label} ({count})`.
2. **Selected chips** (only when non-empty) — `Tag` chips with an `<Cross />` icon; clicking a chip calls `toggle(c)` which routes through the unselect branch.
3. **Search input** — controlled `TextInput` wired to `search` → debounced → triggers the candidate fetch.
4. **Scroll box** — fixed `maxHeight: 220; overflow-y: auto`. Contains:
   - Each `Candidate` rendered as a `Checkbox`. `checked` reads from `selectedDocIds` — a memoized `Set<string>` (lines 226–229) for O(1) lookup even when the scroll box holds hundreds of rows.
   - `onCheckedChange={() => toggle(c)}` — Strapi's Checkbox fires this on both check and uncheck; the `toggle` function routes to the correct branch.
   - Empty state (only when `initialLoaded` is true to avoid flashing).
   - Inline `Loader` while a page is fetching.
   - **Sentinel `<div ref={sentinelRef} style={{ height: 1 }} />`** — observed by the IntersectionObserver.

---

## 11. Performance Characteristics

Everything the panel does to stay fast:

- **Deferred mount (§8).** Zero network work until the browser goes idle (capped at 1 s). First paint of the edit view is never blocked by the panel's fetches.
- **Shared deferred signal (§9).** All five sections share a single `requestIdleCallback` slot instead of racing for five.
- **Per-section isolation.** Each `RelationSection` owns its own state and effects. Typing in "Stores" search doesn't re-render or refetch "Brands".
- **Selector-based `useForm` (§10a).** Each section subscribes only to its own form slot. Edits to `title`, `content`, unrelated relations, etc. do not trigger a re-render here.
- **Debounced search (§10e).** 250 ms coalesces bursty typing into a single request.
- **Paginated candidates (§10h).** 30 rows/page. A target with 10,000 rows still loads instantly.
- **Infinite scroll via IntersectionObserver (§10j).** No scroll-handler listeners; the browser tells us when the sentinel is near.
- **Memoized `selectedDocIds` Set (lines 226–229).** O(1) membership lookup in the candidate render loop. Without this, the `checked` computation would be O(selectedList × candidates) — quadratic in the worst case.
- **Functional setter + ref pattern (§10d, §10f).** The initial-selected fetch reads the latest `formValue` through a ref, so (a) user edits during the fetch aren't clobbered and (b) the fetch effect doesn't need `formValue` in its deps — it only runs when *structural* inputs change.
- **Optimistic UI (§10i).** `setSelectedList(next)` paints before any form-state write lands; the form diff is authoritative at save time, so the UI feels instant and the server stays consistent.
- **Cancel flags on every async (§10f, §10h).** Fetches that get superseded don't write stale state.

---

## 12. Hiding the Default Relation Widgets — `src/index.ts`

The panel would be redundant if the default relation widgets also rendered for those five fields. `src/index.ts` rewrites the content-manager's layout configuration on boot to hide them.

```ts
import type { Core } from '@strapi/strapi';

const HIDE_FROM_EDIT: Record<string, string[]> = {
  'api::deal.deal': ['stores', 'brands', 'categories', 'banks', 'tags'],
  'api::coupon.coupon': ['stores', 'brands', 'categories', 'banks', 'tags'],
};

async function hideRelationsFromContentManager(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const [uid, fieldsToHide] of Object.entries(HIDE_FROM_EDIT)) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType) continue;

      const config = await service.findConfiguration(contentType);
      const hidden = new Set(fieldsToHide);

      const prevEdit = config.layouts?.edit ?? [];
      const prevList = config.layouts?.list ?? [];

      const nextEdit = prevEdit
        .map((row: any[]) => row.filter((cell) => !hidden.has(cell.name)))
        .filter((row: any[]) => row.length > 0);
      const nextList = prevList.filter((name: string) => !hidden.has(name));

      const changed =
        JSON.stringify(nextEdit) !== JSON.stringify(prevEdit) ||
        JSON.stringify(nextList) !== JSON.stringify(prevList);

      if (!changed) continue;

      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas: config.metadatas,
        layouts: { ...config.layouts, edit: nextEdit, list: nextList },
        options: config.options,
      });
      strapi.log.info(`[content-manager] hid relations from ${uid} layout`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to rewrite layout for ${uid}: ${err?.message ?? err}`
      );
    }
  }
}

export default {
  register() {},
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await hideRelationsFromContentManager(strapi);
  },
};
```

Line by line:

- **`HIDE_FROM_EDIT` map** — content-type UID → field names to strip from both edit and list layouts. Matches the keys in `RELATION_CONFIG` on the admin side.
- **`strapi.plugin('content-manager').service('content-types')`** — internal service that persists layout configuration in `strapi_core_store_settings`.
- **`strapi.contentType(uid)`** — resolves the schema model (throws if UID doesn't exist; wrapped in try/catch just in case).
- **`service.findConfiguration(ct)`** — reads current config. Returns `{ uid, settings, metadatas, layouts: { edit, editRelations, list }, options }`.
- **Building `nextEdit`:**
  - Each `row` is an array of cells (one row per horizontal group in the edit view).
  - `row.filter((cell) => !hidden.has(cell.name))` drops hidden cells.
  - `.filter((row) => row.length > 0)` drops rows that became empty (otherwise the view renders visible empty rows).
- **Building `nextList`:** Just a flat array of column names. Filter the hidden ones.
- **`changed` diff via `JSON.stringify`.** A simple but effective structural equality. If neither layout mutated, we skip the write — this matters because bootstrap runs on every server start, and `updateConfiguration` is a DB write.
- **`service.updateConfiguration(ct, {...})`** — persists the rewritten layout. We pass through `settings`, `metadatas`, and `options` unchanged (passing partial config here wipes the omitted keys).
- **Error path** — `strapi.log.warn`, not throw. A cosmetic layout tweak should never block the server from starting.
- **`bootstrap` hook** — Strapi runs this once per process start, after services initialize and before the HTTP server accepts connections. Safe place to call internal services.

---

## 13. Verification

How to confirm everything works end-to-end:

1. **Boot.** Run `yarn develop`. Server log should include `[content-manager] hid relations from api::deal.deal layout` (or the equivalent for coupons) on first boot. Subsequent boots will be quiet because the diff short-circuits.
2. **Panel renders.** Open a deal or coupon edit view → look at the right rail. A "Taxonomies" panel should appear with five sections: Stores, Brands, Categories, Banks, Tags.
3. **Default widgets are gone.** Scan the main edit form. The default relation inputs for those five fields should NOT be present (only `title`, `code`, rich text, media, etc.).
4. **Select a tag.** Click a checkbox in any section. The chip appears immediately in the selected row. Save. Reload the page. The selection persists.
5. **Deselect a tag.** Click the `X` on a chip (or uncheck). Save. Reload. The selection is gone server-side.
6. **Idempotency.** Select → deselect → save. The diff should be clean (nothing added or removed).
7. **Debounce.** Open DevTools Network. Type rapidly in a search box. Confirm requests fire roughly every 250 ms, not per keystroke.
8. **Pagination.** Find a relation with more than 30 options. Scroll to the bottom of its scroll box. Watch Network: a request with `?page=2` should fire. Keep scrolling — `?page=3`, etc.
9. **Race-safety.** With Network throttled to "Slow 3G", open an existing deal and immediately toggle a selection while the initial relations fetch is still in flight. The toggle should survive (chip remains) once the fetch resolves.
10. **Create flow.** Create a new deal or coupon. The panel should render; the selected-fetch is skipped (no `documentId`). Picking items still works — they'll be persisted on first save.

---

## Further Reading

- Strapi v5 relations endpoint: `node_modules/@strapi/content-manager/dist/admin/services/relations.mjs` (line 9 for the URL shape).
- Command shape reference: `node_modules/@strapi/content-manager/dist/admin/pages/EditView/components/FormInputs/Relations/Relations.mjs` (lines 47–54 for disconnect, 186–192 for connect).
- Type definitions (`PanelComponent`, `PanelDescription`, `EditViewContext`): `node_modules/@strapi/content-manager/dist/admin/src/content-manager.d.ts`.
