# WordPress → Strapi v5 Migration — How It Works

A technical walkthrough of the migration package at [`migration/`](../migration):
what each moving part is responsible for, how the pieces fit, and which
guarantees they hold.

> **What this doc is for.** It is the *how it works* companion to
> [`migration/README.md`](../migration/README.md), which is the maintained
> reference for *how to run* it — per-phase prose, env catalogue, CLI recipes.
> [`migration/FRESH-MIGRATION.md`](../migration/FRESH-MIGRATION.md) covers the
> from-scratch runbook. Where this doc and the source disagree, the source wins;
> every phase links to its own file below.

---

## 1. Overview

### What it does

The migration ingests a large WordPress 5.x site (coupons and deals plus
supporting taxonomies, media, SEO, and unique coupon codes) and writes the
equivalent Strapi v5 content into PostgreSQL, with media in S3 (or a local
filesystem fallback).

**Sources**

- **MySQL** — WordPress core tables (`wp_posts`, `wp_postmeta`, `wp_terms`,
  `wp_term_taxonomy`, `wp_term_relationships`, `wp_termmeta`, `wp_users`,
  `wp_usermeta`), plus optional `wp_uc_coupons` / `wp_uc_codes` (Unique Coupons
  plugin) and `wp_yoast_indexable` / `wp_yoast_primary_term` when Yoast is
  installed.
- **Filesystem** — `wp-content/uploads/` on disk, for the actual image bytes.

**Targets**

- **PostgreSQL** — Strapi v5's schema: entity tables, Strapi's conventional link
  tables (`{owner}_{field}_lnk`), component join tables (`{owner}_cmps`),
  component data tables, and the polymorphic media join `files_related_mph`.
- **S3 / local** — one record per unique image, deduped by content hash.

### Shape

```
config ─► connections ─► phase loop ─► checkpoints ─► verification
           (MySQL + PG)   (00 → 15)     (per phase)     (non-fatal)
                             │
                             ├── Media inventoried (01)
                             ├── Media uploads happen on demand (02)
                             ├── Taxonomies, pools, codes (03, 05–06)
                             ├── Users + creator backfill (06a)
                             ├── Coupons + deals + relations (07–08)
                             ├── SEO backfill (09)
                             ├── Verify (10)
                             ├── Copy used local media (11)
                             ├── Offer + site-content backfills (12, 13, 13a)
                             └── Media optimize + formats backfill (14, 15)
```

### Resumable by design

Three mechanisms cooperate:

- **Deterministic `document_id`** derived from WordPress primary keys, so every
  insert can use an `ON CONFLICT ("document_id")` clause and be safely repeated.
- **Per-phase checkpoint files** under `migration/.checkpoints/`, which cause
  completed phases to be skipped on a rerun.
- **Persisted id maps**, which let a later phase run standalone without redoing
  its prerequisites.

§9 covers the exact idempotency semantics, which are *not* uniformly
"do nothing on conflict".

### File map

**Orchestration and infrastructure**

| Path | Role |
|---|---|
| [`src/index.ts`](../migration/src/index.ts) | Orchestrator: phase list, `--clean` and `--phase` flags, checkpoint loop |
| [`src/config.ts`](../migration/src/config.ts) | `.env.migration` → typed config; nothing else |
| [`src/db/wp-client.ts`](../migration/src/db/wp-client.ts) | MySQL pool + optional SSH tunnel |
| [`src/db/pg-client.ts`](../migration/src/db/pg-client.ts) | Postgres pool + optional CA-cert SSL |

**Utilities** — [`src/utils/`](../migration/src/utils)

| Path | Role |
|---|---|
| [`id-maps.ts`](../migration/src/utils/id-maps.ts) | The six WordPress→Strapi id maps, persisted as JSON |
| [`checkpoint.ts`](../migration/src/utils/checkpoint.ts) | Phase-completion bookkeeping |
| [`strapi-insert.ts`](../migration/src/utils/strapi-insert.ts) | `generateDocumentId`, `batchInsert`, `insertLink`, `insertComponent`, `linkMedia` |
| [`sanitize.ts`](../migration/src/utils/sanitize.ts) | `clean`, `cleanSlug`, `cleanCode` |
| [`wp-dates.ts`](../migration/src/utils/wp-dates.ts) | UTC vs local date normalization, expiry parsing |
| [`content-status.ts`](../migration/src/utils/content-status.ts) | published / scheduled / expired classifier |
| [`admin-auth.ts`](../migration/src/utils/admin-auth.ts) | bcrypt random password, reset token, name splitter |
| [`media-resolver.ts`](../migration/src/utils/media-resolver.ts) | `resolveMediaRef` + the on-demand upload hook |
| [`media-source-candidates.ts`](../migration/src/utils/media-source-candidates.ts) | Resolves the S3 master key candidates and grouping key for a media row |
| [`image-optimizer.ts`](../migration/src/utils/image-optimizer.ts) | Optimize originals, build the variant matrix and AVIF twins; re-exports the knobs from [`src/constants/image.ts`](../src/constants/image.ts) |
| [`format-gaps.ts`](../migration/src/utils/format-gaps.ts) | `expectedFormatKeys` / `buildGapWhere` / AVIF tombstone reading — the gap model phase 15 is built on |
| [`content-media.ts`](../migration/src/utils/content-media.ts) | Rewrites content-embedded `wp-content/uploads` images through the upload pipeline |
| [`img-rewrite.ts`](../migration/src/utils/img-rewrite.ts) | Pure `<img>`-tag helpers shared by the content rewrite and `fix:content-srcsets` |
| [`richtext-targets.ts`](../migration/src/utils/richtext-targets.ts) | Shared richtext table/column registry for the fix scripts; throws at import on an unmapped UID |
| [`deal-content.ts`](../migration/src/utils/deal-content.ts) | Rejects legacy scratch values in `post_content` so deals get no empty Show Details block |
| [`offer-extract.ts`](../migration/src/utils/offer-extract.ts) | Heuristic `offerText` / `cashbackText` / `bankOfferText` extraction from title and content |
| [`price.ts`](../migration/src/utils/price.ts) | Parses display-formatted Indian prices (`₹17,499.00`, `Rs. 2,899/-`) safely |
| [`homepage-limits.ts`](../migration/src/utils/homepage-limits.ts) | Per-section homepage seed counts (each with a buffer over what the site renders) |
| [`homepage-bank-offers.ts`](../migration/src/utils/homepage-bank-offers.ts) | Enforces the bank-offers repeatable-component cardinality for direct-SQL writes |
| [`acf-repeater.ts`](../migration/src/utils/acf-repeater.ts) | `parseFaqRepeater` for ACF's flat-key repeater format |
| [`yoast-vars.ts`](../migration/src/utils/yoast-vars.ts) | Yoast `%%variable%%` template resolution |
| [`slug-dedup.ts`](../migration/src/utils/slug-dedup.ts) | Per-table slug uniqueness tracker |
| [`cli.ts`](../migration/src/utils/cli.ts) | Strict `--limit` parsing that fails before any DB or S3 access |
| [`logger.ts`](../migration/src/utils/logger.ts) | Winston: colorized console + two log files |

**Phases** — [`src/phases/`](../migration/src/phases)

| Path | Role |
|---|---|
| [`00-preflight.ts`](../migration/src/phases/00-preflight.ts) | Connection probes, schema sanity checks, unique indexes |
| [`01-media-inventory.ts`](../migration/src/phases/01-media-inventory.ts) | WP attachment scan + plugin-dir blacklist |
| [`02-media-upload.ts`](../migration/src/phases/02-media-upload.ts) | On-demand S3/local upload, optimization, hash dedup |
| [`03-taxonomies.ts`](../migration/src/phases/03-taxonomies.ts) | Stores / brands / categories / banks + FAQ + SEO |
| [`05-pools.ts`](../migration/src/phases/05-pools.ts) | `wp_uc_coupons` → `unique_coupon_pools` |
| [`06-codes.ts`](../migration/src/phases/06-codes.ts) | `wp_uc_codes` → `unique_codes` + pool links |
| [`06a-users.ts`](../migration/src/phases/06a-users.ts) | WP authors → `admin_users` + creator backfill |
| [`07-coupons.ts`](../migration/src/phases/07-coupons.ts) | Non-deal posts → `coupons` + all relations |
| [`08-deals.ts`](../migration/src/phases/08-deals.ts) | `is_deal='yes'` posts → `deals` + relations (with the `deal_store` merge) |
| [`09-seo-backfill.ts`](../migration/src/phases/09-seo-backfill.ts) | Fill SEO components from `wp_yoast_indexable` |
| [`10-verify.ts`](../migration/src/phases/10-verify.ts) | Count + integrity + spot checks |
| [`11-copy-used-media.ts`](../migration/src/phases/11-copy-used-media.ts) | Copy locally-provisioned files into Strapi's `public/uploads` |
| [`12-offer-backfill.ts`](../migration/src/phases/12-offer-backfill.ts) | Exact ordered Deal taxonomy reconciliation, with ACF `deal_store` first |
| [`13-site-content.ts`](../migration/src/phases/13-site-content.ts) | Seed the global / homepage / menu / footer single types |
| [`13a-homepage-offer-sections.ts`](../migration/src/phases/13a-homepage-offer-sections.ts) | Coupon-backed homepage section backfill for pre-existing homepages |
| [`14-media-optimize.ts`](../migration/src/phases/14-media-optimize.ts) | Optimize + AVIF-twin backfill for already-migrated media |
| [`15-media-formats-backfill.ts`](../migration/src/phases/15-media-formats-backfill.ts) | Variant-matrix gap backfill (xsmall / thumbnail / AVIF twins) |

**Standalone maintenance scripts** — not part of the phase loop. Each is
dry-run by default and requires `--apply --yes-i-mean-<target>` to write; see
§11.

| Path | npm script | Role |
|---|---|---|
| [`src/backfill-offer-fields.ts`](../migration/src/backfill-offer-fields.ts) | `backfill:offer-fields` | Fill `badge` and the extracted offer/cashback/bank texts; `--reextract` re-derives existing values |
| [`src/drop-legacy-fields.ts`](../migration/src/drop-legacy-fields.ts) | `cleanup:legacy-fields` | Drop superseded columns/tables and their leftover rows |
| [`src/fix-cache-headers.ts`](../migration/src/fix-cache-headers.ts) | `fix:cache-headers` | Rewrite `Cache-Control` metadata on existing S3 objects |
| [`src/fix-content-srcsets.ts`](../migration/src/fix-content-srcsets.ts) | `fix:content-srcsets` | Rebuild `<img>` srcsets inside richtext columns |
| [`src/fix-markdown-richtext.ts`](../migration/src/fix-markdown-richtext.ts) | `fix:markdown-richtext` | Convert leftover markdown in richtext columns to HTML |
| [`src/reset-homepage.ts`](../migration/src/reset-homepage.ts) | — (`tsx src/reset-homepage.ts`) | Clear the homepage single type so phase 13 can re-seed it |

---

## 2. Orchestration — `src/index.ts`

[`src/index.ts`](../migration/src/index.ts) holds a `Phase` list — each entry a
name, a function, and an optional `skipCheckpoint` flag for phases that should
run every time regardless of prior completion (the connection probes,
verification, and the formats backfill).

### Phase order

Order is a dependency chain, not a preference:

- **01 before 03–08** so inventoried attachments are resolvable.
- **03–06 before 07–08** so taxonomies and pools are in the id maps.
- **06a before 07–08** so author ids are available for `created_by_id`.
- **12–15 last**, because they operate on already-migrated rows rather than
  reading fresh WordPress data.

Two phases are worth calling out. **Phase 02 is special**: its entry point only
preloads the hash cache and logs counts — actual uploads happen on demand later,
when a content phase resolves a media reference. And **phase 15 is never
checkpointed**: its candidate SQL is its own idempotency guard, so a `--dry-run`
or `--limit` pilot must never be able to mark it complete and make later
resume-style runs skip the real backfill.

### CLI flags

- `--clean` — wipe migration state before running. Destructive; see below.
- `--phase <name>` — run exactly one phase, whether or not it was previously
  completed. The target phase's prerequisites are not checked.

### The `--clean` contract

> **⚠ This is the destructive path.** `--clean` (exposed as
> `yarn migrate:fresh`) does far more than reset checkpoints. Read this section
> before running it against anything you care about.

It performs four steps, in order:

1. **Clear local state.** Checkpoint markers are deleted, and the id maps are
   cleared in memory **and deleted from disk**. All six maps go — including
   `userIdMap`, without which phases 07/08 cannot set `created_by_id`.

2. **Truncate Strapi data.** An explicit FK-safe list covers link/join tables,
   entity component joins, the shared SEO/FAQ component data, the entity tables
   themselves, and `files`. Critically it **also covers the site-content single
   types** — `homepages`, `menus`, `footers`, `globals`, their `_cmps` joins, and
   the whole family of `components_home_*`, `components_homepage_*`,
   `components_nav_*`, and `components_footer_*` data tables. A `--clean` run
   destroys the seeded homepage, menu, and footer; phase 13 re-seeds them.

   The explicit list is then **extended by auto-discovery**: every table in the
   `public` schema is enumerated, and any additional `*_cmps` or `*_lnk` table
   whose name matches an `OWNED_PREFIXES` allowlist is appended. Strapi
   auto-generates and shortens many of these names — phase 13 in particular —
   so hand-enumeration is not reliable. The prefix allowlist is the safety
   boundary: it deliberately excludes `admin_`, `up_`, `strapi_`, and core
   tables, so admin roles and plugin permissions are never wiped.

   The same enumeration is used to skip tables that do not exist, so
   legitimately-absent tables (a single type with no component fields never gets
   a `_cmps` table) do not produce warnings. Each truncate uses
   `RESTART IDENTITY CASCADE`.

3. **Remove migrated admin users.** Only rows owned by the internal
   `migration_source_entities` registry are deleted, along with their role
   links. A transitional cleanup clause also removes development rows created
   by the retired prefixed-ID format. A super admin created through Strapi's
   console has no registry ownership and survives.

4. **Empty the S3 prefix.** Every object under the configured S3 root path is
   listed and deleted. This refuses to run when the root path is empty, so a
   misconfiguration can never clear an entire bucket.

Nothing outside these tables and that S3 prefix is touched.

### Phase loop and error path

Each phase either runs or is skipped (by `--phase` targeting, or because its
checkpoint says it is already complete). After a non-`skipCheckpoint` phase
succeeds, the loop writes the checkpoint marker **and** persists the id maps, so
a later single-phase run can find its prerequisites.

On a throw the error and stack are logged, the id maps are saved anyway so
partial progress is not lost, and the process exits non-zero. A `finally` block
always closes both database pools — which for MySQL also tears down the SSH
tunnel and its local server.

---

## 3. Config and connections

### Config

[`src/config.ts`](../migration/src/config.ts) reads `.env.migration` and exposes
a single typed `config` object grouped into `ssh`, `wp`, `pg`, `s3`, plus
`wpUploadsDir`, `batchSize`, `mediaConcurrency`, and `logLevel`. Only
`WP_DB_NAME` and `PG_CONNECTION_STRING` are required; everything else has a
default or may be omitted. `~` is expanded in both the SSH key path and the
Postgres CA cert path. `wpUploadsDir` resolves relative to the `migration/`
package directory, not the working directory.

`migration/README.md` is the catalogue of what each variable does. Two are worth
knowing here: `SSH_HOST_FINGERPRINT` pins the tunnel's expected server host key
(MITM protection, required whenever `SSH_HOST` is set), and `S3_ROOT_PATH`
scopes both uploads and the `--clean` S3 wipe.

### WordPress MySQL

[`src/db/wp-client.ts`](../migration/src/db/wp-client.ts) lazily creates the
pool. When an SSH host is configured, it first opens a tunnel: an SSH connection
plus a local TCP server on an OS-assigned port, forwarding each socket to the
MySQL host **as seen from the bastion** (so the database host may be `localhost`
from that vantage point). The MySQL pool then connects to that local port.
ssh-agent authentication takes precedence over a private key file on disk.

Two pool options are load-bearing: `charset: utf8mb4` preserves 4-byte UTF-8
coming out of WordPress, and `dateStrings: true` is why every phase treats
`post_date` and friends as **strings**. Left to its defaults, the driver would
coerce datetimes into local-timezone `Date` objects and silently drift the
values; keeping them as strings lets `wp-dates.ts` interpret them
deterministically. The query helper uses prepared statements, so every
placeholder in the phases is genuinely parameterized.

### Strapi Postgres

[`src/db/pg-client.ts`](../migration/src/db/pg-client.ts) is a lazy singleton
pool. With no CA cert path configured, SSL is off (local development only). With
one, a relative path resolves against the working directory and a missing file
throws immediately, so a misconfigured cert fails at pool creation rather than
mid-migration. Helpers return rows directly or the first row / `null`.

Both pools are lazy: a read-only single-phase run opens a connection when its
first query fires, not at process start.

---

## 4. Shared utilities

### `id-maps.ts` — the spine

Six maps, each persisted as its own JSON file under `migration/.checkpoints/`:

| Map | Key → value |
|---|---|
| `termIdMap` | `wp_term_id` → Strapi entity ref (stores/brands/categories/banks) |
| `postIdMap` | `wp_post_id` → Strapi entity ref (coupons/deals) |
| `mediaIdMap` | `wp_attachment_id` → Strapi `files.id` |
| `poolIdMap` | `wp_uc_coupons.id` → Strapi pool ref |
| `poolNameMap` | pool name (raw **and** lowercased) → Strapi pool ref |
| `userIdMap` | `wp_users.ID` → Strapi `admin_users.id` |

An entity ref carries the numeric `id`, the `documentId`, the Strapi UID, and the
Postgres table name — enough for any later phase to build a link row without
another lookup.

Two behaviors matter beyond storage. `ensureTermMapping` is the one map that
**lazy-loads from the database on a miss**: it recomputes the deterministic
`document_id` for each of the four taxonomy tables and queries them in turn,
first hit wins, then caches. That is what lets phases 07, 08, and 06a's backfill
run standalone under `--phase` without phase 03 in the same process. And pool
names are stored under both a raw-trimmed and a lowercased key, with lookup
preferring the exact match — because the pool name recorded in coupon metadata
is often cased differently from the pool's canonical name.

`clearAllMaps` clears memory **and deletes the files**; only `--clean` calls it.

### `strapi-insert.ts` — every insert goes through here

`generateDocumentId` is the idempotency keystone. Given a source key it returns
a prefixless 24-character truncated SHA-256 of that key, so the same WordPress
row always produces the same `document_id` across runs and machines. Without a
source key it returns a random CUID — used only for `files`, where dedup is by
content hash rather than document id.

Source-key conventions per phase:

| Phase | Scheme | Example |
|---|---|---|
| 03 | `term:{table}:{wpTermId}` | `term:stores:42` |
| 05 | `pool:{wpPoolId}` | `pool:7` |
| 06 | `unique-code:{wpCodeId}` | `unique-code:15023` |
| 06a | `user:{wpUserId}` | `user:1` |
| 07 | `coupon:{wpPostId}` | `coupon:3110` |
| 08 | `deal:{wpPostId}` | `deal:3299` |
| 02 | (random CUID) | — |

Migration ownership is recorded separately in
`migration_source_entities(document_id, source_key, target_table)`. This keeps
public/API document IDs prefixless while allowing `--clean`, verification, and
offer re-import reconciliation to distinguish migrated rows from hand-created
ones.

The other exports:

- **`batchInsert`** — generic multi-row insert. It chunks rows so a single
  statement never exceeds PostgreSQL's hard limit of 65535 bind parameters,
  dividing that budget by the column count. Optionally appends
  `ON CONFLICT (<column>) DO NOTHING`.
- **`insertComponent`** — Strapi v5 splits component storage across a *data*
  table (e.g. `components_shared_seos`) and a `{entity}_cmps` *join* table. This
  helper pre-checks the join table for an existing row at the same
  entity/field/type/order before inserting, so re-runs do not duplicate
  components.
- **`insertLink`** — generic many-to-many link insert with
  `ON CONFLICT DO NOTHING`; callers pass the column map explicitly.
- **`linkMedia`** — inserts into `files_related_mph`, Strapi's polymorphic media
  join, with `ON CONFLICT DO NOTHING`.

### Text, date, and status helpers

- **[`sanitize.ts`](../migration/src/utils/sanitize.ts)** — `clean` trims and
  maps empty to `null`; `cleanSlug` lowercases, converts spaces and underscores
  to hyphens, strips anything outside `[a-z0-9-]`, collapses runs of hyphens, and
  trims leading/trailing ones; `cleanCode` is `clean` named for coupon codes.
- **[`wp-dates.ts`](../migration/src/utils/wp-dates.ts)** — three normalizers,
  all returning an ISO string or `null`. GMT columns are assumed UTC when they
  carry no offset; non-GMT columns are parsed as local time and used only as a
  fallback; expiry values are accepted either as a Unix timestamp or as a date
  string, since WordPress plugins write both.
- **[`content-status.ts`](../migration/src/utils/content-status.ts)** — maps a
  post's date, status, and expiry to `contentStatus` plus `scheduledAt` and
  `publishedAt`. Precedence is **expired > scheduled > published**. An expired
  offer keeps its `publishedAt`: it was live once, it is simply no longer active.
- **[`slug-dedup.ts`](../migration/src/utils/slug-dedup.ts)** — a per-table set
  of used slugs; a collision gets `-1`, `-2`, and so on appended. Guarantees
  uniqueness **within a single process run**.
- **[`yoast-vars.ts`](../migration/src/utils/yoast-vars.ts)** — resolves Yoast's
  `%%variable%%` templates, substituting the entity title and the current year,
  blanking the ones that have no equivalent here, and stripping any remaining
  `%%…%%` token. The site name is baked in.
- **[`acf-repeater.ts`](../migration/src/utils/acf-repeater.ts)** — ACF stores
  repeaters as flat meta keys (a count row plus `faq_items_0_faq_question`,
  `faq_items_0_faq_answer`, …). `parseFaqRepeater` reads the count and walks the
  indexed keys, skipping any item missing half of its pair.
- **[`admin-auth.ts`](../migration/src/utils/admin-auth.ts)** — a random bcrypt
  password nobody can guess, a reset token so the first login is a
  forgot-password flow, and a display-name splitter that splits on the first
  space.
- **[`media-resolver.ts`](../migration/src/utils/media-resolver.ts)** —
  `resolveMediaRef` turns a WordPress media reference into a Strapi `files.id`.
  Numeric ids hit the media map, falling through to an on-demand upload on a
  miss. URLs cannot be resolved and are dropped with a debug log — WordPress
  media fields normally hold attachment ids, but a pasted URL occasionally slips
  in.

### Logging and checkpoints

[`logger.ts`](../migration/src/utils/logger.ts) is Winston with three transports:
a colorized console, `migration.log`, and an errors-only `migration-errors.log`.
[`checkpoint.ts`](../migration/src/utils/checkpoint.ts) exposes
"is this phase complete", "mark it complete", and "clear the markers" — where
clearing deliberately spares the `*Map.json` id-map files, which `--clean`
deletes separately.

---

## 5. Phase reference

Each phase's own file is the authoritative description of its SQL;
`migration/README.md` carries the operator-facing prose.

### 00 — Preflight

Read-only safety checks; throws if anything is wrong, and always runs. Probes
both databases, asserts the required WordPress tables exist (logging presence of
the optional plugin and Yoast tables), asserts the required Strapi tables exist,
and then **creates the unique indexes the rest of the migration depends on**: one
on `document_id` per entity table, a partial one on `files.hash`, and a composite
one on `files_related_mph`. Without those, `ON CONFLICT` clauses would error
rather than resolve. It finishes by logging discovered link/component tables and
a summary of WordPress row counts.

### 01 — Media inventory

Scans WordPress for `image/*` attachments and builds an in-memory inventory. Two
filters apply: non-images never enter the pipeline at all, and attachments whose
upload path begins with a known plugin directory (backups, popup assets,
migration-tool dumps, and similar) are skipped via a `SKIP_DIRS` blacklist.
Alt text is fetched in a single round trip and joined in memory.

For each kept attachment the local file path is computed and its existence
recorded. Missing-locally attachments stay in the inventory but are counted
separately — they cannot be uploaded later, since phase 02 needs the bytes to
compute a hash. A late-binding fallback fetches a single attachment on demand,
so phases 07/08 can resolve media even when run standalone without phase 01.

### 02 — Media upload (on demand)

The phase entry point only preloads the hash cache from existing `files` rows, so
a re-run never re-uploads an image already in Strapi. Real uploads happen when a
content phase resolves a media reference.

An upload proceeds as: check the media map, resolve the inventory item, read the
bytes once and hash them, and check the hash cache — a hit records the mapping
and returns the existing file id. The hash is always taken from the
**pre-optimization source bytes**, so dedup and idempotency are unaffected by
re-encoding. Concurrent posts referencing the same image share one upload through
an in-flight map keyed by resolved path.

On the S3 path, supported raster types are optimized first: EXIF orientation
baked in, downscaled to fit a maximum box, JPEG and PNG converted to WebP, and
WebP/AVIF/TIFF re-encoded. Animated, vector, and undecodable inputs pass through
untouched. The original is uploaded under an SEO-friendly per-image folder key
that embeds a slice of the content hash, with immutable cache headers — safe
precisely because the key changes when the content changes. Markup-capable MIME
types are forced to a binary content type and attachment disposition so they can
never execute inline. For optimized files the responsive variant matrix and the
AVIF twins are then generated and uploaded into the same folder, and the
resulting `formats` JSON stored on the row.

Without S3 configuration, the local fallback does no optimization and no
variants: it records a `local` provider row pointing at the source path, and
phase 11 performs the actual copy.

All optimization, breakpoint, and AVIF knobs come from
[`src/constants/image.ts`](../src/constants/image.ts), re-exported through
`utils/image-optimizer.ts` and shared with the admin upload extension — so the
migration and the running app can never drift.

### 03 — Taxonomies

Migrates WordPress `category` terms into four Strapi tables, chosen by the
`choose_type` term meta (`Store`/`Brand`/`Category`/`Bank`, defaulting to Store
with a warning). One pivoted query per run collects core columns, the term meta
fields, and the KK-Star-Ratings values that the plugin stores against the term id.

Slugs are **hierarchical**: the term's parent chain is walked upward to produce
`grandparent/parent/child`, with a visited set guarding against cycles in
malformed data, and the result passed through the slug deduplicator. This is why
store slugs are nested paths rather than single segments.

Per term the phase inserts the entity, links its image (as `logo`, or `icon` for
categories), inserts FAQ components when FAQs are enabled, and inserts an SEO
component when Yoast term meta supplies a title or description. The entity insert
upserts: on a `document_id` conflict it refreshes the `description` column rather
than doing nothing, so re-runs pick up edited WordPress descriptions.

### 05 — Coupon pools, 06 — Unique codes

Both are skipped cleanly when the Unique Coupons plugin is absent (phase 05
probes `information_schema` first). Phase 05 copies pools, computing the total
and used code counts with correlated subqueries so no second pass is needed, and
populates both the pool id map and the pool **name** map.

Phase 06 is batched, because the codes table can hold hundreds of thousands of
rows. Per batch it bulk-inserts codes with `DO NOTHING`, then resolves ids: the
`RETURNING` clause only yields newly-inserted rows, so the remainder are looked
up by their deterministic document ids in one array-parameter query. Pool links
are then written in sub-batches sized to stay under the bind-parameter limit.

### 06a — Users and creator backfill

Migrates WordPress post authors into Strapi admin users with the Editor role,
then backfills `created_by_id` and `updated_by_id` across migrated content. It
fails fast with remediation text if the `strapi-editor` role does not exist —
Strapi must have booted at least once to seed default roles.

Only **active post authors** are migrated, not every WordPress user (most of whom
are spam registrations). WordPress's zero-date convention is mapped to `NULL`,
and the query casts datetimes to strings as belt-and-braces against server builds
that ignore the connection-level setting. Names resolve in priority order: the
first/last name user meta, then the display name (but only when it is not an
email address), then the nicename, login, or a synthesized fallback.

The upsert is by **email**: no match inserts a new registry-owned admin user with
a random password and a reset token; a match on the same deterministic
document ID updates names while preserving any non-empty username; a match on
another document ID is left completely alone — that is a hand-created Strapi
user who happens to share the address, and only the role link and id-map entry
are wired. The retired prefixed development format is normalized to the current
prefixless ID when encountered. A single skip for a missing email is tolerated,
but a run where every insert failed is a hard error.

The creator backfill then resolves each post's and term's author through the
user id map and applies the updates in chunks via a bulk join-update against a
`VALUES` list, which avoids a temp table. Terms use a "latest post authoring the
term" heuristic, routed through `ensureTermMapping` to find the right taxonomy
table.

### 07 — Coupons, 08 — Deals

The partition line is the `is_deal` post meta: deals join on it, coupons exclude
it. Both phases bulk-prefetch their per-post meta, term relations, and Yoast
primary terms in parallel before processing posts concurrently.

Shared behavior:

- **Source lifecycle** includes `publish` and `future` posts. A `draft` or
  `trash` post is included only when its valid source expiry has already
  elapsed, because WordPress expiry plugins commonly withdraw old offers by
  changing their post status. Other withdrawn posts are not imported.
- **Dates** prefer the GMT column, fall back to the local column, then to now.
- **Expiry** is read in precedence order: the Action Manager plugin's meta wins;
  otherwise the expiration-date status must indicate a live expiration; last
  resort is the raw expiration meta. The parsed value then drives
  `computeMigrationStatus`.
- **Content** has WordPress shortcodes stripped, is sanitized, and is passed
  through `rewriteContentMedia`, which re-hosts embedded `wp-content/uploads`
  images through the same upload pipeline. Deals additionally run
  `cleanDealContent`, which rejects legacy scratch values (bare prices, coupon
  codes, structurally empty HTML) so a deal never renders an empty Show Details
  disclosure.
- **Offer text** — `offerText`, `cashbackText`, and `bankOfferText` are extracted
  heuristically from the title and content by
  [`offer-extract.ts`](../migration/src/utils/offer-extract.ts). This is a
  best-effort backfill default that editors can correct; cashback and bank spans
  are removed before the badge is computed so a bank discount is never mistaken
  for the headline offer.
- **`badge`** is set to `Recommended` when the WordPress popular-coupon meta is
  set. (There is no `is_popular` column; that mapping moved to the badge.)
- **Author** resolves through the user id map, or stays null when the author was
  never migrated.
- **Both inserts upsert.** On a `document_id` conflict they refresh the extracted
  text fields and content — and for deals, the price columns — rather than doing
  nothing. Re-running a content phase therefore *improves* existing rows when the
  extraction logic changes, while leaving editor-owned fields untouched. See §9.
- **Inventory reconciliation** removes only registry-owned rows that are no
  longer in the expected source partition. This makes re-import converge when a
  source post is deleted/withdrawn or changes between Coupon and Product Deal,
  while preserving hand-created Strapi offers.

Deal-specific: prices go through [`price.ts`](../migration/src/utils/price.ts),
which handles display-formatted Indian prices that a naive parse would silently
truncate. Deal media tries the deal-image meta first and falls back to the
generic image meta, always landing on the `dealImage` schema field.

Taxonomy wiring differs slightly. Coupons insert the Yoast primary term first (so
it lands at order 1) then the remaining terms, with a per-target-table order
counter. Deals do the same but additionally track which target ids they have
already linked per table — that dedup is what makes the **`deal_store` merge**
safe: the `deal_store` meta holds a term id, and routing it through the same
link helper means a store already linked as a taxonomy is not linked twice. This
is why a dedicated display-store link table is no longer needed.

### 09 — SEO backfill

Fills SEO components on the four taxonomy tables for terms that have SEO data in
Yoast's newer denormalized indexable table but not in the term meta that phase 03
reads. For each table it finds which entities already have an SEO component,
looks up the remainder's original WordPress term id through the id map, resolves
the Yoast title template, and inserts the component. It fails soft: a missing
Yoast table logs a warning and continues.

### 10 — Verify

Always runs and **never throws** — its purpose is a sanity report, not a gate.
It compares WordPress and Postgres counts per entity, checks that migrated users
carry the Editor role and that migrated content has a creator, looks for coupons
and deals with no taxonomy at all, checks slug uniqueness per taxonomy table,
reports SEO component coverage as a percentage, and prints a few random rows as
a spot check. Migrated-only checks are scoped by the ownership registry.
§10 explains how to read the output.

### 11 — Copy used media

Only meaningful when phase 02 used the local provider. It selects `local`-provider
files that are actually joined to some entity — the join is what filters out
unused files — and copies each from its recorded source path into Strapi's
`public/uploads`, skipping targets that already exist and counting sources that
have vanished as failures.

### 12–15 — Backfills

These run against already-migrated rows rather than fresh WordPress data.

- **12 — Offer backfill.** Rebuilds each Deal's four taxonomy link sets from
  current WordPress data. The ACF `deal_store` term is ordered first in
  `stores`, then the Yoast primary term and remaining source terms. Replacement
  is transactional per Deal, so re-runs remove stale owners and converge with a
  clean import.
- **13 — Site content.** Seeds the four frontend single types — global, homepage,
  menu, footer (all publish-only). Sections are built from migrated entities and
  ACF option keys, with per-section counts from
  [`homepage-limits.ts`](../migration/src/utils/homepage-limits.ts); each carries
  a buffer over what the site renders so a mid-cycle expiry never leaves a hole,
  and a parity test pins those counts to the component schemas' `max`. Every
  component and relation table name is verified against `information_schema`
  first, and each single type is skipped when its table already has a row.
- **13a — Homepage coupon offer sections.** Backfills the coupon-backed
  `exploreOffers` / `offersByBrand` component trees onto homepages created before
  those components existed, preserving the legacy criteria. Idempotent
  (populated sections are skipped), transactional, and serialized on the homepage
  row. Missing component infrastructure fails the phase — apply the schemas
  first, then rerun it standalone.
- **14 — Media optimize.** Two passes over already-migrated S3 images. Pass 1
  takes rows with no `formats` and an optimizable MIME type, optimizes the
  original and generates the full variant matrix including AVIF twins, writing
  every column in a single update as the last step; superseded objects are
  deleted when the key changes, unless `--keep-originals`. Pass 2 takes rows that
  have `formats` but no AVIF twins and merges the twins in. Source bytes resolve
  from a local uploads hash map first, then the S3 object.
- **15 — Media formats backfill.** Closes the gap phase 14 cannot: rows that
  **already have** `formats` but are missing rungs added later (xsmall, thumbnail,
  AVIF twins). Per row it computes expected-minus-stored keys via
  [`format-gaps.ts`](../migration/src/utils/format-gaps.ts), generates only what
  is missing from the current S3 master, and merges the result last.

  A dropped AVIF twin — one the size guard rejected because the WebP counterpart
  was already smaller — is recorded as a tombstone in `provider_metadata` rather
  than left as a permanent gap, which is what keeps the selector convergent so a
  re-run after a successful pass selects almost nothing. Rows sharing an S3
  master are grouped so the master is fetched and decoded once, while each row
  still merges its own missing set. Variant uploads are conditional so re-runs
  never rewrite bytes already in place (a not-implemented response from the
  storage backend falls back to unconditional puts). `--overwrite` regenerates
  everything unconditionally **and replaces the tombstone list** with this run's
  actual drops — the escape hatch after encoder tuning. Never run this phase
  concurrently with phase 14: both write `provider_metadata` wholesale.

---

## 6. Relationship wiring

Strapi v5 relationships live in two kinds of tables.

### Many-to-many link tables

Named `{ownerTable}_{fieldName}_lnk`, with an id column per side plus one or two
`_ord` columns for ordering:

| Table | Columns |
|---|---|
| `coupons_stores_lnk` | `coupon_id, store_id, coupon_ord` |
| `coupons_brands_lnk` | `coupon_id, brand_id, coupon_ord` |
| `coupons_categories_lnk` | `coupon_id, category_id, coupon_ord` |
| `coupons_banks_lnk` | `coupon_id, bank_id, coupon_ord` |
| `coupons_unique_coupon_pool_lnk` | `coupon_id, unique_coupon_pool_id, coupon_ord` |
| `deals_stores_lnk` | `deal_id, store_id, deal_ord` |
| `deals_brands_lnk` | `deal_id, brand_id, deal_ord` |
| `deals_categories_lnk` | `deal_id, category_id, deal_ord` |
| `deals_banks_lnk` | `deal_id, bank_id, deal_ord` |
| `unique_codes_pool_lnk` | `unique_code_id, unique_coupon_pool_id, unique_code_ord` |

Ordering increments **per owner and per target table**, so a coupon's stores are
numbered independently of its brands. The Yoast primary term is inserted first
and therefore lands at order 1. Every link insert goes through `insertLink` with
`ON CONFLICT DO NOTHING`, so re-running a content phase never duplicates rows.

### Polymorphic media — `files_related_mph`

One table for all media links, keyed by file id, owner id, owner Strapi UID, the
schema field name, and an order. The composite unique index created in phase 00
is what makes its conflict clause work. Field names in use: `logo` (stores,
brands, banks), `icon` (categories), `image` (coupons), `dealImage` (deals).

### Components — `{entity}_cmps`

Component data lives in its own table (`components_shared_seos`,
`components_shared_faq_items`, and the whole `components_home_*` family) while
`{entity}_cmps` joins those rows to their owner by entity id, component id,
component type, field name, and order. `insertComponent` pre-checks that join to
stay idempotent across re-runs.

---

## 7. Media filtering and resolution

The pipeline is deliberately lazy and dedup-first:

1. **Inventory-time filtering** (phase 01) drops non-images and plugin-directory
   artifacts. Nothing is written yet — it is all in memory.
2. **On-demand upload** (phase 02) means an attachment is uploaded only when a
   content phase actually references it. A media library of 50,000 items where
   8,000 are used costs bandwidth for 8,000. It also sharpens the error surface:
   a failed upload is attributable to the content row that needed it.
3. **Dedup by content hash.** Identical bytes under two WordPress attachment ids
   produce one `files` row and two media-map entries. The partial unique index on
   `files.hash` enforces this at the database level too.
4. **Morph linking.** Every resolved reference becomes one `files_related_mph`
   row for the owning entity and schema field.
5. **Orphan-safe.** When a reference cannot be resolved — missing local file,
   non-image, a URL instead of an id — the caller skips the link and the entity
   is still inserted without media. No throw, no retry, a debug log.

---

## 8. Connection lifecycle

Both pools are created lazily on first query. The MySQL pool builds its SSH
tunnel first when one is configured; the Postgres pool reads its CA cert at
creation time.

Shutdown always runs from the orchestrator's `finally` block, and **order
matters**: end the MySQL pool first (closing the pooled connections piping
through the tunnel), then the local tunnel server, then the SSH client.

On the MySQL side everything is read-only and parameterized. On the Postgres side
most work is single-statement autocommit rather than explicit transactions — safe
because idempotency comes from deterministic document ids and conflict clauses,
so a process that dies mid-phase leaves nothing to unwind. Phase 13a is the
exception: it is transactional and serialized on the homepage row.

---

## 9. Idempotency

Three layers stack:

1. **Deterministic `document_id`** plus a conflict clause on every entity insert.
2. **Phase checkpoints** — a completed phase is skipped on a normal re-run.
3. **Persisted id maps** — a later phase can run standalone against a database
   populated by a different process.

The conflict clause is **not uniform**, and the difference is worth knowing
before you re-run anything:

| Phase | On `document_id` conflict |
|---|---|
| 03 taxonomies | Refreshes `description` |
| 05 pools, 06 codes | Does nothing |
| 07 coupons | Refreshes the extracted offer/cashback/bank texts and content |
| 08 deals | Refreshes those plus `sale_price`, `mrp`, `discount`, and content |
| Links, components, media | Does nothing |

So re-running phases 03, 07, or 08 is not a no-op: it re-derives those specific
columns from WordPress and the current extraction logic. That is intentional —
it is how an improvement to offer extraction reaches already-migrated rows —
but it does mean **editor changes to those particular fields are overwritten by
a re-run**. Every other column, and every relation, is left alone.

`--clean` is the opposite direction: wipe all three layers, the migrated rows,
and the S3 prefix, ready for a fresh run. `--phase <name>` is the surgical
option: run exactly one phase whether or not it was previously complete.

---

## 10. Verification playbook

Run [`10-verify.ts`](../migration/src/phases/10-verify.ts) on its own:

```bash
yarn migrate --phase 10-verify
```

Then read the sections:

- **Record counts.** Every entity should pass. Common explanations for a gap: a
  users shortfall matches the skipped-no-email count in the phase 06a logs; a
  coupon mismatch usually means a specific post errored — grep
  `migration-errors.log` for its id; codes far below WordPress usually means
  phase 05 was skipped while phase 06 ran, so pool mapping failed.
- **Users and creator backfill.** Migrated users missing the Editor role should
  be zero. A non-zero null-creator count is acceptable when it is no larger than
  the number of authors skipped for a missing email.
- **Relationship integrity.** Coupons or deals with no taxonomy should be zero.
  Non-zero means either the post genuinely had no WordPress category, or its
  terms had an unrecognized `choose_type` and fell into the default bucket.
- **Slug uniqueness.** Should always be zero. Non-zero implies phase 03 ran
  across multiple processes, since the deduplicator's tracker is per-process.
- **SEO coverage.** Informational only; there is no target threshold.
- **Spot checks.** Eyeball the random rows: names should look right, and codes
  should be present on unique-type coupons (deals rarely have them).

---

## 11. Runbook

Setup and CLI recipes live in [`migration/README.md`](../migration/README.md).
This is what to do when something fails.

**`admin_roles 'strapi-editor' not found`** — thrown by phase 06a. Start Strapi
once so default roles are seeded, then re-run that phase alone.

**`PG CA cert not found at …`** — thrown at Postgres pool creation. Either remove
the CA cert path (if the target does not need chain verification) or place the
file at the absolute path shown in the error.

**`wp_uc_coupons table not found. Skipping pools migration.`** — expected when
the Unique Coupons plugin is not installed. Phases 05 and 06 become no-ops.

**`wp_yoast_primary_term not available`** — expected without Yoast. Primary-term
ordering falls back to WordPress's natural term order.

**`Batch N failed`** — in phase 06. Batch offsets do not move backwards, so
re-running the phase re-attempts from the first unsatisfied offset; already
inserted codes are no-ops.

**`S3 PutObjectCommand failed`** — a phase 02 on-demand upload. The calling
content row still inserts, with the media reference simply unresolved. Fix
credentials or the bucket, then re-run the owning content phase: previously
uploaded images hit the dedup cache and only the failures are retried.

**Phase 15 exits immediately with `S3 not configured — skipping`** — expected
when no bucket or access key is set, unless you passed `--dry-run` (which needs
no S3 access at all). Configure S3 or use `--dry-run` for the report.

**Phase 15 aborts on `--limit`** — the limit parser is deliberately strict and
fails **before any database or S3 access**. `--limit` must be followed by a
positive integer; a typo like `--limit --overwrite` aborts rather than silently
running against the entire catalog.

**A maintenance script refuses to write** — the `fix:*`, `backfill:*`, and
`cleanup:*` scripts, and `reset-homepage`, are dry-run by default and require an
explicit confirmation flag naming their target. Run once with no flags to see the
diff, then re-run with `--apply --yes-i-mean-<host-or-bucket>`, where the target
is the exact host or bucket printed in the log line. The mismatch is the point:
it is what stops a script aimed at local from running against production.

**Partial progress after a crash** — just re-run the migration; checkpoints pick
up where it stopped. Only if you suspect corrupted state should you reach for
`--clean`, and only after reading its contract in §2 — it destroys the seeded
homepage, menu, and footer along with everything else.
