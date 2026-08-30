# AI content translation

Automatic, provider-agnostic LLM translation of localized content (Arabic
for couponzguru.ae first; any registry language later). English is the
single source of truth: saving an English entry re-translates its locale
versions, replacing manual edits made there.

## How it works

- **Storage** — core Strapi i18n. Localized types carry
  `pluginOptions.i18n.localized` per translatable attribute
  (text/richtext/components); slugs, coupon codes, affiliate links, enums,
  media, prices, counters and datetimes stay shared, and Strapi's own i18n
  sync keeps those aligned across locale rows on every documents-API write.
- **Trigger** — the document-write middleware enqueues one coalesced job per
  document+locale into `translation_outbox` (same transaction as the write).
  The dispatcher (`src/translation/outbox/`) claims jobs with leases,
  translates changed text (source-hash gate — an unchanged source costs no
  LLM call), rebuilds the locale version through
  `strapi.documents().update({ locale })` so sanitization/validation/ISR all
  run, and re-mirrors relations (owner side, ordered, missing targets
  retried then accepted with a note).
- **Quality pipeline** — two independent LLM roles per entry: an Arabic
  writer pass, then a native copy-editor pass, each structurally validated
  (exact HTML structure, protected numbers/prices/URLs/placeholders,
  target-script presence, no untranslated English) with one corrective
  retry. Output that still fails is NEVER published: the current Arabic
  version is retained and the job automatically retries with queue backoff under
  `TRANSLATION_QUALITY_GATE_FAILED`. No human language-review or manual
  requeue step blocks publication. The source hash includes a prompt
  fingerprint, so
  editing a prompt file deliberately re-translates affected content on the
  next sweep (mind the daily budget when you tune prompts).
- **Translation memory** — every delivered translation is also stored per
  leaf path in `translation_state.translations` (jsonb). The state table is
  NOT in the migration's truncate list, so **repeated `migrate:fresh` runs
  in the same database are free**: the re-import recreates the same
  deterministic documentIds with identical English, the hashes match, and
  the backfill rebuilds every locale row from memory with zero LLM calls —
  only genuinely changed English pays. A hash match WITHOUT stored memory
  is treated as stale (re-translate), never rebuilt from the possibly-wiped
  locale row.
- **Provider** — `TRANSLATION_PROVIDER=openai-compatible` (any
  /chat/completions vendor via `TRANSLATION_BASE_URL`) or `anthropic`.
  Prompt template per language under `src/translation/locales/prompts/`.
- **Publication** — a validated writer+editor result is written directly to
  the published Arabic locale. Translation runs asynchronously after the
  English save, so the English request stays fast; until it succeeds, the
  previous Arabic version remains live.
- **Cost controls** — every physical provider attempt is first reserved in a
  transactional usage ledger, then settled with actual token/cost data.
  `TRANSLATION_DAILY_BUDGET_USD` is a concurrency-safe hard stop (UTC midnight
  reset), and the backfill dry run estimates both AI passes.
- **Admin UX** — a "Translation" edit-view side panel (status per locale +
  Translate/Re-translate; the trigger needs the assignable
  `translation.manage` permission), and Country Setup carries the site-level
  switch (`translationEnabled` + `translationLocales`).
- **Frontend** — the storefront serves each extra language under its path
  prefix (`/ar/…`, matching the URL shape the live couponzguru.ae Arabic
  pages already have indexed — same English slugs, so the migration keeps
  every `/ar/` URL 1:1): the Astro middleware strips the prefix and pins
  the request's content language, `strapiFetch` appends `?locale=`, a
  read-side document middleware in the CMS injects that locale into every
  content read, the ISR outbox twins every invalidated path with its
  localized path, and rendered documents get their internal links/form
  actions re-prefixed (`src/lib/language-links.ts`) so a visitor browsing
  `/ar/…` stays in Arabic — including links inside translated rich text.

## Enabling on a deployment (owner runbook)

1. Fill the `TRANSLATION_*` env block (see `.env.example`) on the CMS hosts.
2. Deploy/restart once with the block set, then in **Settings → Country
   Setup** turn **Translation enabled** on and set target locales (`ar`).
3. **Restart Strapi** — locale creation, the sync locale mirror and the
   dispatcher all start at bootstrap.
4. Grant editor roles the `ar` locale (Settings → Roles → Content Manager →
   locales) and, if editors may trigger paid translations, the
   "Trigger AI translations" permission.
5. Dry-run the cost: `POST /translation/backfill { "dryRun": true }` (super
   admin, admin session) and review `estimatedUsd`.
6. Backfill: `POST /translation/backfill {}` — idempotent and resumable
   (re-POST any time; hash-current entries no-op). Watch
   `GET /translation/outbox-status`.
7. Watch failures/retries in the Translation panel or
   `GET /translation/outbox-status`. Successful results publish automatically.

India/USA: nothing to do — with the Country Setup switch off the subsystem
never writes a row, never starts, and the CM stays single-locale.

## Adding a language later (e.g. Hindi)

1. Add the data row in `src/translation/locales/table.ts`.
2. Add `src/translation/locales/prompts/hi.md` (the localization brief).
3. Add the storefront dictionary entry for UI chrome when that ships.
4. Country Setup: `translationLocales = "ar,hi"` → restart → backfill.

No new code paths — outbox, field maps, URL prefixes, hreflang and ISR
twins all iterate the registry.

## Storefront behavior

Arabic pages use RTL direction, Arabic global search and offer controls, a
visible language switcher, localized metadata/hreflang, and language-sticky
internal links. Search sends the active content locale to the CMS so Arabic
queries rank and hydrate Arabic records. Localized sitemap membership remains
separate from route serving and page-level hreflang.
