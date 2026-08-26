# Fresh Migration Runbook

Step-by-step guide for migrating WordPress → Strapi into an **empty** target
database (new environment, go-live, or a full re-do). For reference material —
what each phase does internally, data mapping, troubleshooting — see
[README.md](./README.md). For refreshing only the homepage on an already
migrated database, skip to [Maintenance scripts](#maintenance-scripts).
Country identity, feature readiness, USA starter behavior and the India
compatibility contract are explained in
[Country Setup and Multi-Country Sites](../docs/country-setup.md).

Everything here runs **from your local machine**. The scripts connect directly
to the target Postgres (`PG_CONNECTION_STRING`) and to the WordPress MySQL
(directly or through the built-in SSH tunnel). You never need shell access to
the server or the Docker container.

---

## 1. Prerequisites

- [ ] **Strapi deployed and booted once** against the target database. The
      migration writes raw SQL into tables that only Strapi creates — coupons,
      deals, all `components_home_*` tables, link tables. A brand-new database
      that Strapi has never booted on will fail phase 00/13 with "missing
      required infrastructure". Booting also runs the bootstrap routines
      (public read permissions, homepage section labels, view configs).
- [ ] **Target Postgres reachable from your machine** — for DigitalOcean
      managed DBs, add your IP to the cluster's trusted sources.
- [ ] **WordPress MySQL reachable** — a local dump loaded into MySQL, or the
      live server via the SSH tunnel settings below.
- [ ] **WordPress uploads** — local copy of `wp-content/uploads/` (media
      files are read from disk, not over HTTP).
- [ ] **S3 bucket + credentials** for media (optional — empty `S3_BUCKET`
      records files with the local provider instead).
- [ ] Node 18+ and dependencies installed: `cd migration && yarn install`.

## 2. Configure the target

```bash
cp .env.migration.example .env.migration   # if starting from scratch
# USA: merge .env.migration.usa.example only after replacing every MUST-SET value
```

`PG_CONNECTION_STRING` in `.env.migration` **is the target selector** — every
script in this package (migration, reset, markdown fix) writes to whatever it
points at. Point it at the deployed database deliberately, and treat the file
as secret (it is gitignored; never paste its contents into chats or logs).

Key settings (full list in README § Setup & Configuration):

| Variable | Purpose |
|---|---|
| `MIGRATION_PROFILE` | Validated country profile name, such as `india` or `usa` |
| `MIGRATION_STATE_DIR` | Profile-only checkpoints, maps, manifests, reports and logs; normally `.state/<profile>` |
| `MIGRATION_SITE_CONFIGURATION_FILE` | Country identity/localization and catalog/editorial/legal feature JSON created or updated in Phase 13; campaigns are entity templates |
| `MIGRATION_EXCLUSIONS_FILE` | Exclusions for this source only; USA must not reuse the India retired-store list |
| `SOURCE_COUNTRY_CODE` / `SOURCE_LOCALE` / `SOURCE_CURRENCY_CODE` / `SOURCE_TIMEZONE` | Source identity asserted against the profile JSON |
| `WP_TABLE_PREFIX` | Validated WordPress prefix; USA uses `wp_dda10ab629_` |
| `PG_CONNECTION_STRING` + `PG_CA_CERT_PATH` | Target Strapi Postgres (TLS verified for remote DBs) |
| `WP_DB_*` | Source WordPress MySQL |
| `SSH_HOST` / `SSH_PRIVATE_KEY_PATH` / `SSH_HOST_FINGERPRINT` | Optional tunnel to the WP DB (fingerprint is required when tunneling) |
| `WP_UPLOADS_DIR` | Local path to `wp-content/uploads/` |
| `S3_*` | Media destination |

Before continuing, review the effective profile, state path, WordPress prefix,
source country and target database. Phase 00 refuses a target database already
configured for another country, but that guard is not permission to leave
destination values implicit.

An `EXPECTED_ATTACHMENT_COUNT` mismatch is advisory: Phase 00 warns and
continues because a live WordPress site may add media after the local files
snapshot. Phase 01 remains authoritative for file availability and reports all
attachments whose originals are absent from `WP_UPLOADS_DIR`. Store and Deal
count exceptions remain blocking.

The India profile adopts a pre-profile `.checkpoints/` directory only when it
is the sole location with JSON state. If both `.checkpoints` and
`.state/india` contain real state, stop and reconcile them; do not copy or
merge ID-map files casually.

## 3. Run the migration

### 3.0 Bootstrap the media manifest (once per machine — huge speedup)

On a **fresh database**, the hash-based media reuse index (the `files` table)
is empty, so without a manifest every image would be re-optimized and
re-uploaded even though its immutable objects already sit in S3. The manifest
(`<MIGRATION_STATE_DIR>/fileManifestMap.json`, mirrored to
`{S3_ROOT_PATH}/.migration/files-manifest.json`) carries the full row payload
per content hash, letting the import re-create `files` rows with **zero**
image processing. Build it once:

```bash
# Preferred when the OLD database still exists: exact, fast.
# (Temporarily point PG_CONNECTION_STRING at the old DB, then point it back.)
yarn manifest:rebuild --from-db

# Otherwise: reconstruct from the S3 listing + local uploads tree.
# `ambiguous` in the summary is the small tail the normal path will reprocess.
yarn manifest:rebuild
```

After the first manifested run, phase 02 keeps the manifest current and the
S3 mirror makes future machines bootstrap-free — this step never needs
repeating.

### 3.1 Migrate

```bash
yarn migrate
```

One command runs every phase in order. Each phase checkpoints on completion,
so if anything fails you fix the cause and re-run `yarn migrate` — it resumes
from the active profile's state directory. To re-run one phase against existing data, use
`yarn migrate:phase <name>`. Media stats at the end show
`reused` (manifest hits — no processing) vs `uploaded` (full pipeline).

The final phase (`16-orphan-media-cleanup`) deletes S3 objects under
`S3_ROOT_PATH/` that no imported `files` row references — it only runs when
every prior phase succeeded, refuses to act on an empty/wrong database, and
trips a fuse above 40% orphans (`--force-orphan-cleanup` to override). Pass
`--dry-run` to preview deletions, or run it standalone via
`yarn cleanup:orphan-media -- --dry-run`.

### What `--clean` destroys

> 🛑 **`yarn migrate:fresh` is `tsx src/index.ts --clean` — the most
> destructive command in this repo. It is not a checkpoint reset.** Against
> whatever `PG_CONNECTION_STRING` points at, and with no confirmation prompt,
> it deletes:

| # | What | Detail |
|---|---|---|
| 1 | Checkpoint files | `<MIGRATION_STATE_DIR>/*.json` checkpoint markers — every phase becomes eligible again |
| 2 | **All six ID map files** | `termIdMap` / `postIdMap` / `mediaIdMap` / `poolIdMap` / `poolNameMap` / `userIdMap` `.json` are unlinked from disk (`clearAllMaps()`). Relationship data from earlier phases is **not** retained |
| 3 | Every migrated non-media table | `TRUNCATE … RESTART IDENTITY CASCADE` over the explicit list in [`src/index.ts`](./src/index.ts) — coupons, deals, stores, brands, categories, banks, unique pools/codes, all link tables, all `components_*` tables — **plus** every `*_cmps` / `*_lnk` table auto-discovered from `information_schema` under the owned-prefix allowlist. The `files` table is preserved so its hashes can reuse existing media |
| 4 | **The four content singles** | `homepages`, `menus`, `footers`, `globals` and their component join tables are in that truncate list. A "fresh" run therefore wipes the curated homepage, menu, footer and global settings, and phase 13 reseeds them from WordPress. `site_configurations` is preserved as the target-country guard and Phase 13 updates it from the active profile |
| 5 | Migration-created admin users | `admin_users` rows owned by `migration_source_entities` (phase 06a's accounts) and their role links. Accounts created by hand in the admin — including the super admin — survive |
| 6 | Media only with `--delete-media` | Ordinary `--clean` preserves the `files` table and all S3 objects. Reuse verifies each retained AWS master in S3 and regenerates only a missing object. `yarn migrate:fresh --delete-media` also truncates `files`, then `clearS3Bucket()` deletes every object under `S3_ROOT_PATH/` in `S3_BUCKET`. It refuses an empty `S3_ROOT_PATH`, and `--delete-media` is rejected unless paired with `--clean` |

> Only the admin-user step and optional S3 deletion guard are scoped. Nothing
> else is reversible without a database backup. On a live catalog, take one
> first.

### Phase order

| Phase | What it does |
|---|---|
| `00-preflight` | Validates both DBs and required tables — fails fast, writes nothing |
| `01-media-inventory` → `02-media-upload` | Catalogs WP media and uploads to S3 |
| `03-taxonomies` | Stores, brands, categories, banks. Timestamps come from the date range of each term's posts, not from import wall-clock — see [§ Entity timestamps](#entity-timestamps-and-sitemap-lastmod) |
| `05-pools` → `06-codes` → `06a-users` | Unique-coupon pools/codes, authors |
| `07-coupons` → `08-deals` | The offers themselves (content sanitized through the shared `cleanHtml` allowlist on the way in) |
| `09-seo-backfill` | Yoast SEO fields |
| `10-verify` | Count/spot-check verification report |
| `11-copy-used-media` → `12-offer-backfill` | Media wiring and offer relation backfill |
| `12a-entity-updated-at` | Re-derive entity `created_at`/`updated_at` from the offers now linked to them |
| `13-site-content` | Global, **homepage**, menu, footer singles |
| `13b-footer-media` | Upload optimized flags for every other country in the shared registry, plus any profile-specific Google Preferred icon, and fill missing footer media/component relations |
| `13c-footer-country-links` | Fill blank footer country destinations while preserving editor-entered URLs |
| `13d-site-selection-backfill` | Preserve legacy homepage Popular Searches and fill empty search-overlay stores/suggestions without overwriting editor selections |
| `14-media-optimize` | Image optimization backfill |
| `15-media-formats-backfill` | Variant-matrix gap backfill for **already-migrated** media only — on a fresh run phase 02 already generates every variant and this is a no-op (never checkpointed, safe to re-run) |

Logs: console + `migration.log` (full) + `migration-errors.log`.

### Homepage seed counts

Phase 13 fills each homepage section to the counts in
[`src/utils/homepage-limits.ts`](./src/utils/homepage-limits.ts) — the site
renders 4 fewer per section (the +4 buffer absorbs offers that expire or get
deleted mid-cycle; hero and popular stores carry no buffer). A parity test
(`yarn test`) pins these to the component schema `max` values, since raw SQL
bypasses Strapi validation.

### Entity timestamps and sitemap `lastmod`

Stores, brands, categories and banks own ~99% of the site's public URLs, and
their Strapi `updated_at` is what the sitemap emits as `<lastmod>`. WordPress
terms carry **no date columns at all**, so this phase used to stamp all three
timestamp columns with `new Date()` — meaning every `migrate:fresh` republished
the entire catalogue as "changed today". Google only uses `lastmod` while it is
verifiably accurate and drops the signal site-wide when it is not, so an
import-stamped value is worse than none.

Two phases now derive honest values from data that *does* carry real dates:

| Phase | Source |
|---|---|
| `03-taxonomies` | `MIN(post_date_gmt)` / `MAX(post_modified_gmt)` over the published posts filed under the term, via `wp_term_relationships` |
| `12a-entity-updated-at` | `MIN(created_at)` / `MAX(updated_at)` over the coupons and deals actually linked to the entity in Strapi |

12a runs last and wins where an entity has offers. That ordering is deliberate:
the sitemap describes the Strapi catalogue, not the WordPress state it came
from, and 12a sees the offers that were really migrated. Entities with no
offers keep their phase-03 value; entities with neither fall back to import
time, and the sitemap omits `<lastmod>` rather than inventing one.

To repair an already-migrated database without a full re-run, use
`yarn backfill:entity-updated-at` — the same derivation, standalone.

## 4. Verify

- [ ] Phase `10-verify` output shows no missing counts.
- [ ] `GET <strapi-url>/api/homepage-full` — sections filled to the seed
      counts: topOffers 8, popularStores 1+24, topDeals 10, cgExclusive 8,
      exploreOffers ≤10/tab, newlyAdded 8, offersByBrand 7, bankOffers 12.
- [ ] `GET <strapi-url>/api/search?q=<known store>` returns grouped results.
- [ ] `GET <strapi-url>/api/site-settings` reports the expected country,
      locale, timezone and currency.
- [ ] Every enabled feature reports `ready: true` and `live: true`; a campaign
      reports the selected entity-owner `path`.
- [ ] Content Manager omits Off country features; campaign singletons appear
      only when an entity owns their template.
- [ ] Admin: log in, open Homepage, **save once** — proves component caps and
      image validation pass on the seeded data.
- [ ] Homepage contains Coupon-backed **Explore Offers** and **Offers by Brand**
      only; the retired Deal-backed fallback fields are absent.
- [ ] Spot-check a store page and a Coupon homepage banner URL (CDN base correct).

For USA, the review report must additionally account for 7,162 Stores, 10,360
attachments, zero Product Deals, five hero banners and eight featured Stores.
Brands, Categories, Banks, Product Deals and unsupplied editorial/legal pages
must remain disabled; neither campaign template has an owner. Run the migration a second time
against the disposable target and confirm those counts do not grow.

## 5. Restart Strapi (required)

Restart **both** CMS containers (`strapi` and `strapi-render`) after the
import completes. The boot-time reconcilers — content-contract (published_on /
coupon_type / alt-text fill), site-selection, search-index, and
unique-code-integrity — only ever run during a boot, and the pre-import boot
saw an empty database. None of them run on a cron except the nightly pool
recount, so a post-import boot is what lets them see the imported rows. The
same boot re-applies admin view configs and the search runtime against real
content.

Since the importer now writes every reconciled field at insert time, the
reconcilers should report **~0 changes** — the restart is the safety net, not
the mechanism.

- [ ] Restart performed; boot log shows no non-zero `[content-contract]`
      reconcile counts.

## 6. After migration

- Admin users/roles are not migrated — create editors in the admin and re-save
  role permissions if needed.
- The frontend (static build or ISR gateway) needs a full build/re-render once
  content exists.

---

## Maintenance scripts

All of these live in this package, share `.env.migration` targeting, print
their target, and **refuse destructive actions without a `--yes-i-mean-<target>`
flag** matching that target — the Postgres host, or the S3 bucket for
`fix:cache-headers`.

Every one of them defaults to a dry run **except `reset-homepage`, which has
no preview mode**: given its confirmation flag it backs the homepage tables up
to `backups/` and then deletes immediately. Without the flag it prints the
target and exits non-zero.

| Script | Purpose |
|---|---|
| `yarn tsx src/reset-homepage.ts` | Back up and delete the homepage row so phase 13 can reseed it — **no dry run; deletes as soon as it is confirmed** |
| `yarn fix:markdown-richtext` | Repair markdown artifacts left by the old admin editor |
| `yarn fix:cache-headers` | Stamp immutable `Cache-Control` on already-uploaded S3 objects |
| `yarn fix:content-srcsets` | Rebuild rich-text `<img>` srcsets from the current `files.formats` |
| `yarn backfill:offer-fields` | Fill `badge`, Coupon `offerText`, and Coupon/Deal benefit texts on offers migrated before those fields existed |
| `yarn backfill:entity-updated-at` | Repair store/brand/category/bank timestamps on an already-migrated database — the same derivation phase 12a runs, for when a full `migrate:fresh` is not wanted |
| `yarn backfill:taxonomy-descriptions` | Fill blank taxonomy long descriptions from WordPress without replacing existing Strapi editor copy |
| `yarn cleanup:legacy-fields` | Drop the columns, component rows and tables left orphaned by removed features |

### Reseed only the homepage

Phase 13 skips the homepage when a row already exists. To rebuild it under
current seeding rules (e.g. after changing section caps):

```bash
yarn tsx src/reset-homepage.ts --yes-i-mean-<pg-host>   # backs up all homepage tables to backups/, then deletes the row
yarn migrate:phase 13-site-content                       # reseeds
```

### Repair markdown artifacts in richtext columns

Only needed on databases whose content was edited with the old markdown admin
editor — a fresh migration sanitizes everything on import and does not need it:

```bash
yarn fix:markdown-richtext                               # dry-run: prints would-be changes
yarn fix:markdown-richtext --apply --yes-i-mean-<pg-host>
```

### Backfill S3 Cache-Control headers

Media uploaded before the immutable Cache-Control setting serves with no
cache header at all. This stamps `public, max-age=31536000, immutable` on
every object via an in-place `CopyObject` that carries the stored
Content-Type, content headers, user metadata, storage class, and SSE settings
through unchanged — only Cache-Control changes. Objects already carrying the
value are skipped, so re-runs are cheap and idempotent:

```bash
yarn fix:cache-headers                                   # dry-run: lists objects that would change
yarn fix:cache-headers --apply --yes-i-mean-<s3-bucket>  # confirmation flag names the BUCKET
```

### Rebuild rich-text image srcsets

Content HTML is written once at migration time, so rich-text `<img>` srcsets
are frozen at whatever variant matrix existed back then. This rebuilds
`srcset`/`sizes` from the current `files.formats` — optionally run it after
`yarn migrate:phase 15-media-formats-backfill`. Only tags whose `src` is an
exact master URL from `files.url` are touched; everything else is logged and
left as-is. Writes raw SQL, so changed entries stay stale on the frontend
until the next rebuild:

```bash
yarn fix:content-srcsets                                 # dry-run: prints the diff
yarn fix:content-srcsets --apply --yes-i-mean-<pg-host>
```

### Backfill missing taxonomy long descriptions

Use this after a migration when WordPress gained Store/Brand/Category/Bank
descriptions after phase 03 completed. It fills only `NULL`/blank Strapi
descriptions, so CMS-authored copy always wins. The source HTML passes through
the phase-03 sanitizer and embedded WordPress media is migrated and linked.

```bash
yarn backfill:taxonomy-descriptions                    # read-only coverage report
yarn backfill:taxonomy-descriptions --apply --yes-i-mean-<pg-host>
```

The apply run rechecks the blank predicate inside each write transaction and
then runs the coverage audit again. It exits non-zero if any fillable target
remains blank.

### Backfill the newer offer fields

For databases migrated **before** `badge` / `cashbackText` / `bankOfferText`
existed (and before Coupon `offerText` existed). It is **fill-only** — every field is written only
where it is currently NULL, so editor edits and re-runs are never clobbered —
and it uses the same extractor as phases 07/08, so backfilled values match a
fresh run. Deal `offerText` is intentionally absent; Deal promotion copy is
the editor-owned `discount` value. Deploy the new schema and **boot Strapi once
first** so it creates the nullable columns; the script only fills them, and warns-and-skips per
table if a column is missing. Run it **before** `cleanup:legacy-fields`, which
drops the `is_popular` column that the `badge` backfill reads:

```bash
yarn backfill:offer-fields                               # dry-run: prints counts
yarn backfill:offer-fields --apply --yes-i-mean-<pg-host>
```

Add `--reextract` to re-derive offer/cashback/bank text for **all** rows
(clearing them first) after improving the extractor — `badge` is left
untouched.

### Drop legacy columns and tables

Strapi never drops columns or tables when a field is removed from a schema (it
orphans them to avoid data loss), so this cleans up after the tag / offerType /
Amazon-deal / isPopular / cashbackItems removals: the `is_popular` and
`offer_type` columns on coupons/deals, the two Amazon columns on `globals`,
the `amazonTopBanner` media morph rows, the `cashbackItems` component rows and
their `components_shared_chips` table, and the `tags` table with its two link
tables. Every step is guarded (`IF EXISTS` / scoped `DELETE`s), so a database
that never had a given object is a safe no-op and re-runs are idempotent:

```bash
yarn cleanup:legacy-fields                               # dry-run: reports what exists
yarn cleanup:legacy-fields --apply --yes-i-mean-<pg-host>
```

### Targeting a different database ad hoc

Override the connection for a single command instead of editing
`.env.migration` (empty `PG_CA_CERT_PATH` disables TLS for local):

```bash
PG_CONNECTION_STRING=postgresql://user:pass@127.0.0.1:5432/strapi PG_CA_CERT_PATH= \
  yarn tsx src/reset-homepage.ts --yes-i-mean-127.0.0.1
```
