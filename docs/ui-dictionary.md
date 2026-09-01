# Storefront UI-text dictionary

The storefront's own chrome text — buttons, labels, headings, aria-labels,
empty states, form messages, meta-title templates — is served from a
dictionary the CMS stores and the admin edits under **Settings → UI Text**.
The storefront owns the **keys** and the English **defaults**; the CMS owns
English **overrides** and every other language. This page is the contract
between the two repos and the operator guide for the page.

Code: `src/api/ui-dictionary/` (content API + admin controller),
`src/translation/ui-dictionary/` (store, translation job, admin service),
`src/admin/features/ui-dictionary/` (the page),
`database/migrations/2026.09.01T00.00.00.create-ui-dictionary.js` (tables).

## 1. What the catalogue is

The storefront keeps a typed English catalogue in code. Every immutable UI
image contains a flattened, versioned artifact, and `deploy.sh` synchronizes
that artifact once through `POST /api/ui-dictionary/catalogue`. The deployment
fails if synchronization fails; page requests, traffic, and container restarts
never write to the CMS. The CMS stores the artifact in `ui_catalogue` (one row
per key: catalogue text,
description, declared `max_length`, `plural_of`, an optional English
`override_text`) and keeps translations in `ui_translations` (one row per
`(locale, key)`, `origin` `ai` or `manual`). Catalogue meta (version, sync time,
counts) lives in the core store under `plugin_ui-dictionary_catalogue`.

Frontend ownership, fallback order, bundle boundary and contributor workflow
are in [Storefront localization and UI text](https://github.com/vickydalmia/cguru-ui/blob/main/docs/localization.md).
Exact host setup, rollout and rollback commands are in the frontend
[production deployment guide](https://github.com/vickydalmia/cguru-ui/blob/main/docs/deployment.md#first-catalogue-sync-rollout).

Nothing is ever hand-created in the CMS: a key exists because a storefront
deployment synchronized it. Keys the storefront removes are soft-removed
(`removed_at`) and never served; a rollback deploy that synchronizes them again
revives them together with their translations.

## 2. Key format and caps

| Rule | Value |
| --- | --- |
| Key pattern | `^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$` (e.g. `offers.showDetails`) |
| Keys per catalogue | ≤ 5,000 |
| Key length | ≤ 255 |
| Text length | 1 – 2,000 characters, not blank |
| Description length | ≤ 500 |
| `maxLength` | positive integer, optional; enforced on overrides, translations and AI output |
| Sync body | ≤ 1,048,576 bytes; `version` = lowercase sha256 hex (64 chars); `entries` non-empty |
| Placeholders | `{name}` tokens; no markup in messages |

## 3. `POST /api/ui-dictionary/catalogue` (storefront → CMS)

Authentication: a Strapi **API token** (`Authorization: Bearer …`). The route
carries the auto-derived content-API scope
`api::ui-dictionary.ui-dictionary.syncCatalogue`, so the token must be of type
**Custom** with `Ui-dictionary → syncCatalogue` ticked. A Read-only token gets
**403**. Rate limit: 12 requests / 60 s per IP.

Body:

```json
{
  "version": "<sha256 of the flattened catalogue>",
  "entries": {
    "common.viewAll": { "text": "View all", "description": "Section footer link" },
    "seo.defaultTitle": { "text": "Coupons and deals", "maxLength": 60 },
    "offers.count.one": { "text": "{count} offer", "pluralOf": "offers.count" },
    "offers.count.other": { "text": "{count} offers", "pluralOf": "offers.count" }
  }
}
```

Response `200`:

```json
{ "data": { "unchanged": false, "added": 3, "changed": 1, "removed": 0, "version": "<sha256>" } }
```

- Idempotent by `version`: a second identical sync returns `unchanged: true`
  and does nothing (no jobs, no ISR sweep).
- A change upserts the rows, soft-removes absent keys, writes the meta, then
  enqueues one dictionary translation job per enabled language (reason
  `catalogue sync`) when any key was added/changed/revived, and requests one
  ISR sweep. Log line: `ui-dictionary.catalogue_synced`.
- A plural form key must be `<pluralOf>.<CLDR category>` and its base must
  push an `other` form.
- Validation failure → `400 { error: "Invalid catalogue push", problems: [{ path, message }] }`.
  The response keeps the original error wording for API compatibility; the
  lifecycle and UI consistently call the operation a deployment sync.
  (first 50 problems).

## 4. `GET /api/ui-dictionary?locale=xx` (CMS → storefront)

Anonymous; rate limit 60 / 60 s; server response cache 60 s keyed by path
(+ `locale` for enabled codes only); `Cache-Control: public, max-age=60`.

```json
{
  "data": {
    "locale": "ar",
    "version": "<sha256 or null before the first deployment sync>",
    "updatedAt": "2026-09-01T10:00:00.000Z",
    "messages": { "common.viewAll": "عرض الكل", "seo.defaultTitle": "…" }
  }
}
```

Fallback rules the storefront relies on:

| `locale` | `messages` |
| --- | --- |
| `en`, absent, unknown, or not enabled in Country Setup | **English overrides only** (keys with `override_text`). A site with no overrides gets `{}`. |
| an enabled target language | `{ …englishOverrides, …translations(locale) }` — a **stale** translation is still served (never English) while its re-translation is pending; keys with neither are omitted so the storefront uses its bundled English. |

Unknown or disabled codes are normalised to `en` *before* the body is built,
so `?locale=zz` cannot mint its own cache entry. `updatedAt` is the newest of
the catalogue sync time, the last override change and the last translation
write for that language.

## 5. English overrides and the staleness rule

Every catalogue row carries two hashes:

- `hash = sha256([text, maxLength])` — the pushed English;
- `effective_hash = sha256([override_text ?? text, maxLength])` — what the
  site shows in English and what the AI translates **from**.

A translation row stores the `effective_hash` it was made from as
`source_hash`. It is **current** while `source_hash == effective_hash`, else
**stale**. Statuses per language: `missing` (no row), `stale`, `ai`, `manual`;
English rows show `source` or `override`.

Consequences:

- Saving an English override changes `effective_hash`, so every language's
  row for that key becomes stale and is re-translated from the override
  (job reason `english override`). An override equal to the pushed text
  clears the override.
- A **manual** translation survives AI runs until *its own key's* English
  changes: the AI write is `ON CONFLICT … DO UPDATE … WHERE origin <> 'manual'
  OR source_hash <> excluded.source_hash`, and the job never even sends a
  manual-current key. "Re-translate all" re-does AI rows only.
- The prompt fingerprint is deliberately **not** part of these hashes: a
  prompt tweak never marks a hand-written translation stale.

## 6. Plural rows

English pushes `base.one` / `base.other` flagged `pluralOf: base`. Each target
language needs whatever `Intl.PluralRules(locale)` says it needs (Arabic:
zero/one/two/few/many/other). The categories English never pushes are
**expansion rows**: not in `ui_catalogue`, translated from the base's `other`
text with a field note such as `plural form 'few' for a count like 3`, stored
in `ui_translations` under `base.<category>`, and keyed to the `other` row's
`effective_hash`. The UI Text page lists them (badge `plural · few`) and they
can be edited or imported like any key; English overrides target pushed keys
only.

## 7. Settings → UI Text (admin page)

Access: the assignable RBAC action **"Edit storefront UI text"**
(`ui-dictionary.manage`, Settings → Roles → *content management → translation*)
gates every read and write. The two translate buttons additionally need
**"Trigger AI translations"** (`translation.manage`), exactly like the
per-entry Translate button. Without the action the page renders the
no-permissions state.

- **Tabs**: English, then one per enabled language (native name, `RTL`-aware
  text direction), each with a badge: overrides count on English,
  `N to translate` / `N done` on a language, `Translating…` while its job is
  pending or processing (the page polls every 8 s in that state).
- **Sync card**: catalogue version, deployment sync time, key/override/removed counts,
  translated / missing / out-of-date / manual counts, the newest job and its
  last error. Before the first deployment sync it points the operator to the
  storefront deployment log and the dedicated token's
  `ui-dictionary.syncCatalogue` permission.
- **Filters** (all in the URL, shareable): search over key/English/translation
  (`_q`), namespace, status (`Missing`, `Out of date`, `AI`, `Manual`;
  `Catalogue English`/`Override` on English), *Show removed keys*.
- **Table**: Key (with `removed`, `plural · <cat>`, `≤ maxLength` badges) ·
  English (italic + `override` badge when overridden) · Translation (in the
  language's direction) · Status · Updated · actions.
- **Edit** opens a dialog with the description hint, the English source,
  the placeholders that must be kept, a textarea in the language's direction
  and a live `n/limit` counter (`maxLength` or 2,000). Saving an English row
  writes an override; any other tab writes a **manual** translation.
- **Clear override** (English) restores the catalogue text. **Reset to AI**
  (other languages, only while translation is active) deletes the row and
  queues a non-forced job so the AI fills it again.
- **Import JSON / Export JSON** for the selected language: `{ "key": "text" }`.
  Export of English is the effective text of every live key; of a language,
  its stored rows. Import of English writes overrides (and queues
  re-translation); of a language, manual rows. Unknown keys, blank/over-length
  text and texts that lose a placeholder are skipped and listed back.
- **Translate missing/stale** (all languages from the English tab, one
  language otherwise) and **Re-translate all** (confirmation; manual texts are
  kept). Hidden when the deployment does not translate; the endpoint answers
  `409` in that state.

Every successful write purges the 60 s public cache for `/api/ui-dictionary`
and requests an ISR sweep (section 9).

### Admin endpoints (admin router, authenticated session + `ui-dictionary.manage`)

| Route | Notes |
| --- | --- |
| `GET /ui-dictionary/status` | `translationActive`, `languages[]`, catalogue meta, per-locale counts, newest job per language |
| `GET /ui-dictionary/entries?locale=xx&includeRemoved=1` | every row for the tab (client-side filtering) |
| `PUT /ui-dictionary/entries/:locale/:key` `{ text }` | `en` → override; else manual translation. `400` on invalid text or missing placeholders (`details.missing`), `404` unknown key |
| `DELETE /ui-dictionary/entries/:locale/:key` | `en` → clear override; else delete + queue a non-forced job |
| `POST /ui-dictionary/import` `{ locale, messages }` | see Import above; returns `written` and `skipped[]` |
| `GET /ui-dictionary/export?locale=xx` | `{ locale, messages }` |
| `POST /ui-dictionary/translate` `{ locale?, force? }` | also needs `translation.manage`; `409` when translation is inactive |

`locale` must be `en` or a language enabled in Country Setup; anything else
is a `400` listing the allowed codes.

## 8. Translation job

The dictionary rides the normal outbox as the synthetic job
`ui-dictionary` / `catalogue` / `<locale>`. The dispatcher hands it to
`processUiDictionaryJob`, which loads the pending leaves (missing + stale, plus
current AI rows under `force`; never manual-current), sorts them by key, cuts
them into groups of 80 and runs each group through the same writer → editor →
validation pipeline as content (`contentType: "Storefront UI text"`, a UI-copy
brief in the user message, per-key `maxLength` only when declared). Each group
is persisted as soon as it returns, so a later failure defers only what is
still missing. Retryable failures (quality gate, provider) → `deferred` with
queue backoff; the daily budget, a lost lease or a non-retryable error stop
the job. One ISR sweep is requested whenever anything was written. A job for
a language that was disabled meanwhile is skipped.

## 9. ISR behaviour

Every dictionary write changes text on every page, so the only honest
invalidation is a full sweep: `enqueueCoalescedIsrSweep` with reason
`ui-dictionary` and payload `{ all: true, scopes: ["chrome", "routes"] }`
(`chrome` drops the storefront's cached dictionaries, `routes` re-renders).
While a sweep with that reason is still **pending**, further writes add no
event — they only purge the CMS response caches. The storefront's own
dictionary cache is 60 s, so a change is visible within one sweep or one
minute, whichever comes first.

## 10. Backfill, estimate, nightly

- `POST /translation/backfill {}` (super admin) enqueues the dictionary after
  the content waves; it is counted under `perUid["ui-dictionary"]`. Passing
  `uids` drops it unless `"ui-dictionary"` is listed.
- `POST /translation/backfill { "dryRun": true }` adds one line per language
  holding the characters of every key still missing or stale there.
- The nightly `nightlyTranslationConsistency` cron (04:45) runs the same
  backfill, so the dictionary heals with the content.

## 11. Rate limits and trusted IPs

`global::rate-limit` is per client IP. The deployment synchronizes once per
release and the storefront reads one dictionary per language per minute, which
fits the 12/min and 60/min budgets — but ISR warms and renders share the same origin
IP, so put the storefront's private IP in `RATE_LIMIT_TRUSTED_IPS` (matched
against the raw socket address, exact IPs or prefixes ending in `.`) as the
deployment docs already require. Without it bursts surface as `429`s.

## 12. One-time seed import

Before the storefront shipped the dictionary it carried hand-written Arabic
strings in code. Those were captured into a scratch `ar.json`
(`{ "key": "text" }`) for a one-time import so they are not re-translated at
cost:

1. Deploy the storefront; wait until UI Text shows a catalogue version.
2. Open the **Arabic** tab → **Import JSON** → paste or pick `ar.json`. The
   rows land as **manual** (kept until their English changes). Skipped keys
   are listed — a key the storefront no longer includes is expected there.
3. **Translate missing/stale** for the remainder.

## 13. Troubleshooting

| Symptom | Check |
| --- | --- |
| UI Text says *Waiting for a storefront deployment to sync its catalogue* | Check the UI deployment log. `UI_CATALOGUE_SYNC_TOKEN` must be a dedicated **Custom** token with `Ui-dictionary → syncCatalogue`; a Read-only token gets `403`. The token belongs only in `env/catalogue-sync.env`. |
| Sync returns `400` | The `problems[]` list names the key: pattern, length, blank text, plural key/category, missing `other` form, or a body over 1 MiB / 5,000 keys. |
| Edited text not on the site | Wait for the `ui-dictionary` ISR sweep (one pending at a time — see the ISR outbox status) and the two 60 s caches (CMS response cache, storefront dictionary cache). |
| A language tab shows `N to translate` and nothing happens | Translation must be active (Country Setup switch + `TRANSLATION_*` env). Check `GET /translation/outbox-status` and the job badge/last error on the sync card. |
| Job `deferred` with `k/n dictionary group(s) failed` | Only those groups retry with backoff; delivered groups are already live. The reason names the key range and the error (quality gate, provider). |
| `409` on Translate | Translation is off on this deployment; manual edits and imports still work. |
| Manual text was replaced by AI | Its key's **English** changed (override or catalogue sync), which is the designed rule. Check the `Updated` column and the English status. |
| A key is missing from `?locale=xx` | It has neither an override nor a translation — the storefront's bundled English is intended there. Removed keys are never served. |
| Intermittent `429` on sync/read | `RATE_LIMIT_TRUSTED_IPS` does not include the storefront's private IP. |

## Related documentation

- [AI content translation](./ai-translation.md)
- [Country Setup and Multi-Country Sites](./country-setup.md)
- [Public API](./public-api.md)
