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
  `strapi.documents().update({ locale })` so sanitization/validation/ISR all
  run, and re-mirrors relations (owner side, ordered, missing targets
  retried then accepted with a note). A deterministic locale-write validation
  or SQL-integrity rejection becomes a terminal failed job after that paid
  result; it is never sent back to the provider in a cost-increasing loop.
- **Quality pipeline** — two independent LLM roles per entry: a writer pass
  in the target language, then a native copy-editor pass, each structurally
  validated (exact HTML structure, protected numbers/prices/URLs/placeholders,
  target-script presence for non-Latin scripts, no untranslated English) with
  one focused corrective retry for only the failed fields. Protected facts are
  replaced with short alphabetically labelled `{{CGPV_*}}` markers before
  either model sees them and restored from the source before validation, so a
  model cannot localize or alter them. Alphabetic labels avoid Arabic-Indic
  digit normalization; harmless marker case/separator spacing is tolerated
  during restoration.
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
  locale row.
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
  Coupon and Product Deal detail URLs retain the default-locale row's numeric
  id in every language (`/coupon/123/` and `/ar/coupon/123/`); aggregate,
  listing, campaign, entity-page and search responses normalize translated
  row ids to that public id before they leave the CMS. The separate redeem
  handoff uses the shared logical identity and is deliberately unprefixed
  (`/redeem/coupon/<documentId>`): code mode, static code, unique pool and
  affiliate destination are shared machine data, not translated content.
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
   `strapi` service and `false` on `strapi-render`. The shared database lease
   is safe with multiple workers, but per-process provider concurrency would
   otherwise multiply paid throughput and make the intended limit misleading.
2. In **Settings → Country Setup** turn **Translation enabled** on and pick
   the target languages in the multi-select (it lists every language ICU can
   name, with native name, `RTL` badge, script and the `/xx/` prefix). Save.
   Turning the switch off later immediately stops the dispatcher on the CMS
   instance handling the save; pending rows remain durable. Restart sibling
   CMS processes so their locale mirrors follow the disabled configuration.
3. The save **hot-applies to the CMS instance that handled it**: the i18n
   locale rows are created, the sync locale mirror the ISR path twins read is
   re-primed and the dispatcher starts (only if the env block parses — an
   incomplete block is logged as `translation.hot_apply … env-missing` and
   nothing starts). **Restart every other CMS container** — locale mirrors
   are per process; only the designated admin process starts
   the dispatcher. A hot-apply failure never fails the save;
   it is logged as `translation.hot_apply_failed` and a restart retries it.
4. Grant editor roles the new locale (Settings → Roles → Content Manager →
   locales) and, if editors may trigger paid translations, the
   "Trigger AI translations" permission; grant "Edit storefront UI text" to
   whoever maintains UI copy.
5. Dry-run the cost: `POST /translation/backfill { "dryRun": true }` (super
   admin, admin session) and review `estimatedUsd` (content + dictionary).
6. Backfill: `POST /translation/backfill {}` — idempotent and resumable
   (re-POST any time; hash-current entries no-op). Watch
   `GET /translation/outbox-status`.
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
2. `languages[]` in `/api/site-settings` now carries the new code, so the
   storefront's routing (`/hi/`), `<html dir>`, hreflang, switcher and the
   ISR twins follow on their next settings refresh (60 s).
3. **Backfill** (`POST /translation/backfill {}` or, for UI text only,
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
