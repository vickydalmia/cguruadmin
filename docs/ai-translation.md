# AI content translation

Automatic, provider-agnostic LLM translation of localized content and of the
storefront's own UI text into any language the admin picks in Country Setup
(Arabic for the UAE site first). English is the single source of truth:
saving an English entry re-translates its locale versions, replacing manual
edits made there.

## How it works

- **Storage** — core Strapi i18n. Localized types carry
  `pluginOptions.i18n.localized` per translatable attribute
  (text/richtext/components); slugs, coupon codes, affiliate links, enums,
  media, prices, counters and datetimes stay shared, and Strapi's own i18n
  sync keeps those aligned across locale rows on every documents-API write.
  Physical content rows are unique by `(document_id, locale)`, never by
  `document_id` alone: every locale version shares the logical document ID.
- **Languages** — Country Setup stores the target languages as a CSV
  (`translationLocales`) picked from a multi-select of every ISO 639-1 code
  the runtime's ICU data can name (`src/translation/locales/resolve.ts`).
  The resolver derives the English and native names, text direction, CLDR
  script and `og:locale` (`code_COUNTRY`) from ICU, so no code table has to
  know a language before an admin can pick it. `en` is the source everywhere
  and is never a target.
- **Trigger** — the document-write middleware enqueues one coalesced job per
  document+locale into `translation_outbox` (same transaction as the write).
  The dispatcher (`src/translation/outbox/`) claims jobs with leases,
  translates changed text (source-hash gate — an unchanged source costs no
  LLM call), rebuilds the locale version through
  `strapi.documents().update({ locale })` so sanitization and ISR run, and
  re-mirrors relations (owner side and ordered). Translation writes carry an
  explicit source/target/write-plan context through the normal validation
  pipeline; sanitization, required values, schema limits, SEO/URL safety,
  Coupon invariants, identity/slug uniqueness and component structure still
  run. A first locale version validates as a create but keeps the document's
  shared documentId, so uniqueness checks recognise the English row as the
  same document. The only source-parity exceptions are the documented legacy
  cases: translated short descriptions do not inherit English's 160-character
  minimum, exact source homepage media IDs may preserve legacy dimensions, and
  a legacy source offer with no taxonomy may mirror that empty taxonomy. The
  offer lifecycle guards (schedule/expiry dates) are not applied to a locale
  write at all: every lifecycle field is non-localized and copied from the
  English row, so an already-expired offer is a stored state, not a target
  defect. A target-only defect is never grandfathered.
- **Dependencies** — required localized relations are resolved before any
  provider call. Coupon/Deal taxonomy is required when it exists in English;
  homepage, menu, footer, global and static-page relations are always required.
  Missing targets put the job in `blocked` with structured `blocked_on` data,
  with no provider call, content write or ISR invalidation. Forward curation
  relations on Store/Brand/Category/Bank may create the base row first, but
  remain blocked until relation repair. Publishing a dependency wakes exact
  `relation-sync` jobs for its parents; unresolved jobs are never delivered.
- **Quality pipeline** — two independent LLM roles per entry: a writer pass
  in the target language, then a native copy-editor pass, each structurally
  validated (exact HTML structure, protected numbers/prices/URLs/placeholders,
  target-script presence for non-Latin scripts, no untranslated English) with
  one focused corrective retry for only the failed fields. Protected facts —
  every digit run (including digits glued to letters such as `90ml`), currency
  amounts (`AED 749`, `AED400`, `$40`), percentages, URLs, e-mails,
  placeholders and HTML tags — are replaced with short alphabetically labelled
  `{{CGPV_*}}` markers before either model sees them, so a model cannot
  localize or alter them. The fact check is then made on the model's raw
  output: every marker exactly once, no unknown marker, and no digit (any
  script), amount, URL or e-mail added outside the markers. The restored text
  serves the structure, budget and script checks. (Re-matching the restored
  Arabic prose with regexes is what dead-lettered the UAE backfill: a
  sentence-final price matched as `AED 749.` while the English matched
  `AED 749`.) Alphabetic labels avoid Arabic-Indic digit normalization;
  marker spelling is strict. The marker brief is part of the per-request user
  message, not the fingerprinted system prompt. The proper-name exemption is
  limited to actual entity `name` fields; promotional titles, overrides and
  descriptions must be translated. If an SEO field exceeds its exact schema
  maximum, the focused correction asks the provider to compact only that
  field without truncating rich text or removing protected values.
  Output that still fails is NEVER published: the current locale version is
  retained and the complete job receives at most
  `TRANSLATION_QUALITY_RETRY_MAX` durable retries (default one), then becomes a
  visible terminal failure instead of spending indefinitely. Root taxonomy
  names may legitimately retain a registered Latin brand name; prose fields
  still require the target script. The source hash includes a prompt
  fingerprint, so editing a prompt file deliberately re-translates affected
  content on the next sweep (mind the daily budget when you tune prompts).
- **Prompts** — `src/translation/locales/prompts/default.md` and
  `default-editor.md` are generic templates rendered with the locale's facts
  (`{{languageName}} {{nativeName}} {{countryName}} {{countryCode}} {{script}}
  {{dir}}`); an unfilled placeholder is a `TRANSLATION_NOT_CONFIGURED` error,
  never a prompt with a hole. A language may instead declare hand-tuned
  files (and a glossary) in `src/translation/locales/table.ts`; today only
  `ar` does (`ar.md`, `ar-editor.md`, `glossaries/ar.md`).
- **Translation memory** — every delivered translation is also stored per
  leaf path in `translation_state.translations` (jsonb). The state table is
  NOT in the migration's truncate list, so **repeated `migrate:fresh` runs
  in the same database are free**: the re-import recreates the same
  deterministic documentIds with identical English, the hashes match, and
  the backfill rebuilds every locale row from memory with zero LLM calls —
  only genuinely changed English pays. A hash match WITHOUT stored memory
  is treated as stale (re-translate), never rebuilt from the possibly-wiped
  locale row. Before a hash-current row is rebuilt, the dispatcher compares
  the complete schema-derived write plan (text, components, media and
  relations) with the persisted locale row. An exact match performs no
  documents-API write and emits no ISR event; a missing row or relation drift
  still rebuilds from memory without an AI call. A successfully validated paid
  result is stored after the final source-hash check and before publication,
  so a later write-validation failure can retry without buying the same text.
- **Consistency sweep** — the nightly sweep is an opt-in recovery net
  (`TRANSLATION_NIGHTLY_CONSISTENCY_ENABLED=false` by default) for writes that
  bypassed the document middleware. It starts a durable `mode: "repair"` scan,
  returns immediately to cron, and labels selected jobs separately. If
  the newest older attempt is a terminal failure and the English source has
  not changed since that attempt, the dispatcher records the nightly check as
  skipped without another provider call. An English edit, catalogue sync or
  explicit `POST /translation/backfill {}` uses a non-nightly reason and can
  retry deliberately. A nightly upsert also cannot overwrite a pending editor
  job's reason. Normal editor writes never depend on the sweep.
- **UI text** — the storefront's chrome strings (buttons, labels, headings,
  aria-labels, meta templates) are not CMS content; they live in the UI-text
  dictionary (`ui_catalogue` / `ui_translations`) that each storefront
  deployment synchronizes once, and the same outbox translates in key groups. See
  [ui-dictionary.md](./ui-dictionary.md) for the contract and the page.
- **Provider** — every transport uses AI SDK 6 behind the existing application
  retry/budget boundary. `TRANSLATION_PROVIDER=openai` uses the official OpenAI
  Responses API (including `gpt-5.6-luna`), `openai-compatible` uses any
  `/chat/completions` vendor via `TRANSLATION_BASE_URL`, and `anthropic` uses
  native Messages. SDK retries are set to zero so every physical request is
  reserved and settled exactly once in `translation_usage`.
- **Publication** — a validated writer+editor result is written directly to
  the published locale version. Translation runs asynchronously after the
  English save, so the English request stays fast; until it succeeds, the
  previous locale version remains live.
- **Cost controls** — every physical provider attempt is first reserved in a
  transactional usage ledger, then settled with actual token/cost data.
  `TRANSLATION_DAILY_BUDGET_USD` is a concurrency-safe hard stop (UTC midnight
  reset), and the backfill dry run estimates both AI passes (content and
  dictionary).
- **Admin UX** — a "Translation" edit-view side panel (status per locale +
  Translate/Re-translate; the trigger needs the assignable
  `translation.manage` permission); **Settings → Country Setup** carries the
  site-level switch (`translationEnabled`) and the language multi-select;
  **Settings → UI Text** (`ui-dictionary.manage` permission) edits English
  overrides and every language's UI strings, imports/exports JSON and
  triggers dictionary translation. The Strapi administration chrome itself
  remains English (`src/admin/app.tsx` declares only the `en` admin locale);
  content locale versions and storefront UI-dictionary values are what get
  translated.
- **Frontend** — the storefront admits an extra-language path only when its
  corresponding localized CMS row exists. The Astro middleware strips an
  admitted prefix and pins the request's content language,
  `strapiFetch` appends `?locale=`, a
  read-side document middleware in the CMS injects that locale into every
  content read, and rendered documents get their internal links/form
  actions re-prefixed (`src/lib/language-links.ts`) so a visitor browsing
  `/ar/…` stays in Arabic — including links inside translated rich text.
  Existing Arabic rows remain routable while an update is pending. A new
  English row has no Arabic route until its first Arabic publication; the
  language switcher and `hreflang` use the same admitted inventory.
  Coupon and Product Deal detail URLs retain the default-locale row's numeric
  id in every language (`/coupon/123/` and `/ar/coupon/123/`); aggregate,
  listing, campaign, entity-page and search responses normalize translated
  row ids to that public id before they leave the CMS. The separate redeem
  handoff uses the shared logical identity. Its browser-facing document keeps
  the current language (`/redeem/coupon/<documentId>` or
  `/ar/redeem/coupon/<documentId>`), while unique-code allocation stays on the
  unprefixed POST route. Code mode, static code, unique pool and affiliate
  destination remain shared machine data and never enter an AI request.
  The list of languages, their direction and `og:locale` come from
  `languages[]` in `GET /api/site-settings`, never from a hardcoded list.

## Enabling on a deployment (owner runbook)

1. Fill the `TRANSLATION_*` env block (start from `.env.example`; the canonical
   variable reference is the frontend repository's
   [CMS translation engine](https://github.com/vickydalmia/cguru-ui/blob/main/docs/environment.md#cms-translation-engine))
   on the CMS hosts and deploy/restart once with it set.
   For the AE Luna rollout use `TRANSLATION_PROVIDER=openai`,
   `TRANSLATION_MODEL=gpt-5.6-luna`, leave `TRANSLATION_BASE_URL` empty, and
   begin with `TRANSLATION_REASONING_EFFORT=none`. Supported reasoning values
   are `none`, `low`, `medium`, `high`, `xhigh` and `max`; use a higher value
   only when the dry run and quality failures justify its extra output cost.
   Set `TRANSLATION_INPUT_COST_PER_MTOK` and
   `TRANSLATION_OUTPUT_COST_PER_MTOK` to the model's current official prices
   before enabling a positive daily budget—model pricing can change, so verify
   it at deployment time rather than copying an old estimate.
   Keep `TRANSLATION_OUTBOX_DISPATCHER_ENABLED=true` only on the admin
   `strapi` service and `false` on `strapi-render`. Backfill ownership is
   independently enabled only on `strapi-maintenance`. The shared database lease
   is safe with multiple workers, but per-process provider concurrency would
   otherwise multiply paid throughput and make the intended limit misleading.
2. In **Settings → Country Setup** turn **Translation enabled** on and pick
   the target languages in the multi-select (it lists every language ICU can
   name, with native name, `RTL` badge, script and the `/xx/` prefix). Save.
   Turning the switch off later immediately stops the dispatcher on the CMS
   instance handling the save; pending rows remain durable. Restart sibling
   CMS processes so their locale mirrors follow the disabled configuration.
3. The save **hot-applies to the CMS instance that handled it**: the i18n
   locale rows are created, the locale registry is re-primed and the
   dispatcher starts (only if the env block parses — an
   incomplete block is logged as `translation.hot_apply … env-missing` and
   nothing starts). **Restart every other CMS container** — locale mirrors
   are per process; only the designated admin process starts
   the dispatcher. A hot-apply failure never fails the save;
   it is logged as `translation.hot_apply_failed` and a restart retries it.
4. Grant editor roles the new locale (Settings → Roles → Content Manager →
   locales) and, if editors may trigger paid translations, the
   "Trigger AI translations" permission; grant "Edit storefront UI text" to
   whoever maintains UI copy.
5. Dry-run the cost: Settings → Country Setup → AI content translation →
   **Estimate cost** (Super Admin; the same as `POST /translation/backfill
   { "dryRun": true }` with an admin session) and review the estimate
   (content + dictionary).
6. Backfill: use **Repair missing/failed translations** on the same card. It
   calls `POST /translation/backfill` with `mode: "repair"` and selects only
   missing rows, stale hashes, latest failed/blocked jobs, incomplete memory
   and relation drift. `mode: "all"` remains the compatible default. Both
   modes accept `locales`, `uids`, `force` and `dryRun`. The scan runs in
   the background: the endpoint answers `202 { accepted, run }` at once (or
   `409` with the active run while one is in progress — one run per shared
   database), and `GET /translation/outbox-status` carries the run
   as `backfill` with its progress (`currentUid`, `documentsScanned`,
   `selected`, `enqueued`) and, when `status` is `done`, the result
   (`selected`, `enqueued`, `skippedCurrent`, `skippedIneligible`,
   `providerCallsExpected`,
   `perUid`, plus the cost fields for a dry run) or, when `failed`, the
   error. Run state, page checkpoints and leases are persisted in
   `translation_backfill_runs`; the dedicated `strapi-maintenance` process
   resumes an interrupted scan at its last completed 50-document page. The
   translation-only populate graph excludes inverse `mappedBy` collections,
   and `TRANSLATION_BACKFILL_MAX_DOCS_PER_SECOND` defaults to 20 so the scan
   cannot starve a two-core portal. Jobs are committed per page as the scan
   advances, so a run is idempotent and resumable: fully current entries
   perform neither a provider call, CMS write nor ISR invalidation. The card shows the scan's progress
   line, then queued / running / blocked / failed / done-today and today's
   spend against the budget, and polls while a scan or jobs are running.
   After a pipeline fix, this manual backfill is what re-runs previously
   failed entries — the nightly consistency sweep deliberately skips a failed
   entry whose English source has not changed. **Stop scan** calls
   `POST /translation/backfill/:id/cancel`; it stops future pages but never
   removes translation jobs already committed by earlier pages.
7. Watch failures/retries in the Translation panel, UI Text's sync card or
   `GET /translation/outbox-status`. Successful results publish automatically.

For a temporary initial backfill while the site has no visitor traffic, keep
the single admin-owned dispatcher and begin with
`TRANSLATION_CONCURRENCY=5`, `TRANSLATION_OUTBOX_BATCH_SIZE=10` and
`TRANSLATION_OUTBOX_POLL_MS=1000`. If ten minutes of status and logs show no
provider rate limits, timeouts, database pressure or rising failures, increase
to `8` / `16`; provider quotas still apply even when the storefront is idle.
Recreate the `strapi` container after changing env values (`restart` does not
reload them). Return to the conservative `2` / `5` / `5000` defaults when the
backfill is complete.

India/USA: nothing to do — with the Country Setup switch off the subsystem
never writes a row, never starts, and the CM stays single-locale.

## Adding a language later (e.g. Hindi)

No deploy is needed:

1. **Country Setup** → add the language in the multi-select → **Save**. The
   instance that took the save creates the locale row, re-primes its mirror
   and (if not already running) starts the dispatcher; restart the other CMS
   containers.
2. `languages[]` in `/api/site-settings` now carries the new code. `<html dir>`
   and localized fetching are available immediately, while individual
   routes, hreflang alternates and switcher destinations appear only after the
   matching locale row is published.
3. **Repair missing/failed translations** (`POST /translation/backfill {
   "mode": "repair" }` or, for UI text only,
   **Settings → UI Text → Translate missing/stale**). New languages render
   the generic `default.md` / `default-editor.md` prompts with Hindi's facts
   substituted; nothing else is required.

Optional — a hand-tuned prompt for that language: add
`src/translation/locales/prompts/hi.md` (and `hi-editor.md`,
`glossaries/hi.md`) and a `hi` row in `src/translation/locales/table.ts`
(`CONTENT_LOCALE_OVERRIDES`). Because the rendered system prompt is part of
every content hash, switching a language to override files (or editing them
later) re-translates that language's whole catalogue on the next backfill —
budget for it.

Do **not** edit `ar.md`, `ar-editor.md` or `glossaries/ar.md` casually: they
are pinned byte-for-byte by the golden test in
`src/translation/prompts.test.ts` (fixtures under
`src/translation/__fixtures__/`). A deliberate change is made by editing the
file and regenerating the fixture with
`UPDATE_PROMPT_GOLDEN=1 yarn test src/translation/prompts.test.ts`, knowing
that the whole Arabic catalogue will be re-translated at real cost.

Removing a language: untick it, Save (the mirror drops it at once, pending
jobs for it are skipped as `locale no longer enabled`), restart the other
containers. Locale rows and stored translations are kept.

## Storefront behavior

Pages in a non-English language use that language's direction (`dir` from
`languages[]`), its global search and offer controls, a visible language
switcher, localized metadata/hreflang, and language-sticky internal links.
Search sends the active content locale to the CMS so localized queries rank
and hydrate localized records. UI chrome text comes from
`GET /api/ui-dictionary?locale=xx` — English overrides plus that language's
translations, falling back per key to the storefront's bundled English — and
every dictionary write triggers one coalesced full ISR sweep. Localized
sitemap membership remains separate from route serving and page-level
hreflang.

Content translation writes use locale-scoped ISR invalidation. For example,
an Arabic Coupon update invalidates `/ar/`, its `/ar/<entity>/` consumers and
its Arabic detail route, but not their English twins or shared redeem/code
caches. The ISR payload's `localePrefix` constrains `all`, paths and scopes to
that language. Localized route membership refreshes only when a locale row is
created or removed. Translation invalidations share one pending outbox event
per locale and merge during a short bounded debounce; a large backfill
therefore advances bounded gateway versions instead of one per row. Shared
non-localized changes such as slug or visibility still invalidate every
affected locale.

`translation-isr:<locale>` is only the database coalescing key. Every durable
ISR row also owns a unique `delivery_key`, stable across retries of that row and
sent to the gateway as its idempotency key. Reusing a locale's coalescing key
there would suppress later translations for the gateway's 31-day dedupe TTL.

## Recovery sequence

Use this order for a production repair after deploying a translation pipeline
change:

1. Disable `TRANSLATION_OUTBOX_DISPATCHER_ENABLED` everywhere; keep Strapi and
   the storefront serving existing rows.
2. Back up `translation_outbox`, `translation_state`, `translation_usage`,
   `ui_catalogue` and `ui_translations`.
3. Deploy the CMS migrations/code, enabling the dispatcher only on the admin
   Strapi process. Deploy the matching storefront SSR and ISR gateway release.
4. While the dispatcher is still stopped, verify idle ISR version counters do
   not advance. Then resume the single dispatcher.
5. Run repair for Store, Brand, Category and Bank and wait for the latest
   pending/processing/blocked/failed counts to reach zero. Repair Coupons and
   product Deals next; then homepage, menu, footer, global, jobs, CMS static
   pages and the UI dictionary.
6. Run one all-UID repair without `force`. Run the identical request again and
   confirm `providerCallsExpected: 0`, no `translation_usage` change, no
   content writes and no ISR version movement.

Operational counts use only the latest job for each document/locale. Historical
failures remain queryable for audit but do not make a repaired catalogue look
failed. A formerly failed job without stored `translation_state.translations`
needs one new provider-backed translation (normally the writer and editor
calls); current or remembered content does not.
