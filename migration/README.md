# CouponzGuru Migration: WordPress + ACF Pro to Strapi 5

Migrates a profiled CouponzGuru WordPress site (posts, taxonomies, media, SEO,
unique coupon codes and Site Configuration) into one Strapi 5 PostgreSQL
backend with S3-hosted media. See
[Country Setup and Multi-Country Sites](../docs/country-setup.md) for the
owner/operator explanation and India compatibility guarantees.

> **Running a migration into a new environment?** Follow the operator checklist in [FRESH-MIGRATION.md](./FRESH-MIGRATION.md) — this README is the reference for what each phase does internally.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup & Configuration](#setup--configuration)
- [How to Run](#how-to-run) — including what `--clean` destroys
- [Migration Phases](#migration-phases)
  - [00 Preflight](#phase-00--preflight) · [01 Media Inventory](#phase-01--media-inventory) · [02 Media Upload to S3](#phase-02--media-upload-to-s3) · [03 Taxonomies](#phase-03--taxonomies)
  - [05 Unique Coupon Pools](#phase-05--unique-coupon-pools) · [06 Unique Codes](#phase-06--unique-codes) · [06a Users](#phase-06a--users) · [07 Coupons](#phase-07--coupons) · [08 Deals](#phase-08--deals)
  - [09 SEO Backfill](#phase-09--seo-backfill) · [10 Verification](#phase-10--verification) · [11 Copy Used Media](#phase-11--copy-used-media) · [12 Offer Backfill](#phase-12--offer-backfill)
  - [13 Site Content](#phase-13--site-content)
  - [14 Media Optimize](#phase-14--media-optimize-backfill) · [15 Media Formats Backfill](#phase-15--media-formats-backfill)
- [Data Mapping](#data-mapping)
- [Media / S3 Pipeline](#media--s3-pipeline)
  - [Maintenance scripts](#maintenance-scripts)
- [SEO & FAQ Components](#seo--faq-components)
- [Idempotency & Resume](#idempotency--resume)
  - [ID Map Persistence](#id-map-persistence)
- [Verification](#verification)

---

## Prerequisites

| Dependency | Details |
|------------|---------|
| **Node.js** | v18+ with `tsx` available (used to run TypeScript directly) |
| **MySQL** | WordPress database dump loaded; core table names are resolved through the validated `WP_TABLE_PREFIX` |
| **PostgreSQL** | Strapi 5 database with tables already created by Strapi (stores, brands, categories, banks, coupons, deals, unique_coupon_pools, unique_codes, files, component tables, link tables) |
| **AWS S3** | Bucket + credentials for media uploads (optional — falls back to local provider records) |
| **WordPress uploads** | Local copy of `wp-content/uploads/` for image file access |

Optional WordPress tables: `wp_uc_coupons`, `wp_uc_codes` (unique coupon plugin), `wp_yoast_indexable` (SEO backfill).

---

## Setup & Configuration

1. Copy the environment template and fill in your values. For USA or UAE,
   overlay `.env.migration.usa.example` or `.env.migration.ae.example`; each
   pins its profile, source identity, classification workbook and isolated
   state directory:

```bash
cp .env.migration.example .env.migration
# Merge the matching country overlay into .env.migration
```

2. Configure the following variables in `.env.migration`:

```ini
# WordPress MySQL
MIGRATION_PROFILE=india       # india or usa
MIGRATION_STATE_DIR=.state/india
MIGRATION_SITE_CONFIGURATION_FILE=profiles/india/site-configuration.json
# MIGRATION_EXCLUSIONS_FILE=profiles/india/excluded-stores.csv  # optional
WP_TABLE_PREFIX=wp_           # validated before any source query
SOURCE_COUNTRY_CODE=IN
SOURCE_LOCALE=en-IN
SOURCE_CURRENCY_CODE=INR
SOURCE_TIMEZONE=Asia/Kolkata
WP_DB_HOST=127.0.0.1
WP_DB_PORT=3306
WP_DB_USER=root
WP_DB_PASSWORD=
WP_DB_NAME=couponzguru

# SSH tunnel to the WP DB (optional; set SSH_HOST to enable)
SSH_HOST=
SSH_PORT=22
SSH_USER=
SSH_PRIVATE_KEY_PATH=~/.ssh/id_ed25519
SSH_PRIVATE_KEY_PASSPHRASE=
# REQUIRED when SSH_HOST is set — pins the server host key (MITM protection).
# Get it: ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -   (use the SHA256:... part)
SSH_HOST_FINGERPRINT=

# Strapi PostgreSQL
PG_CONNECTION_STRING=postgres://strapi:strapi@127.0.0.1:5432/strapi
# Remote DBs use TLS by default; set a CA path to also verify the chain.
PG_CA_CERT_PATH=
PG_SSL_REJECT_UNAUTHORIZED=true
PG_POOL_MAX=10               # Shared pool; clamped to 4..50
# Phase 03 workers; clamped to 1..8 and the shared pool budget.
TAXONOMY_CONCURRENCY=8
# Phase 07 source/content preparation workers; clamped to 1..8.
COUPON_CONCURRENCY=8
# Rows per PostgreSQL Coupon transaction; clamped to 1..500.
COUPON_BATCH_SIZE=250
# Concurrent Coupon batch transactions; clamped to 1..4.
COUPON_BATCH_CONCURRENCY=4

# AWS S3 (leave S3_BUCKET empty to use local file records)
S3_BUCKET=
S3_REGION=ap-south-1
S3_ACCESS_KEY_ID=
S3_ACCESS_SECRET=
S3_BASE_URL=                   # CloudFront / CDN URL (optional)
S3_ROOT_PATH=uploads           # Key prefix in bucket
S3_ENDPOINT=                   # Custom endpoint for Minio, etc.

# Product Deal background removal (required for opaque Deal images)
FAL_KEY=
FAL_BACKGROUND_REMOVAL_CONCURRENCY=2
FAL_BACKGROUND_REMOVAL_TIMEOUT_MS=120000
FAL_BACKGROUND_REMOVAL_MAX_ATTEMPTS=3

# Local WordPress uploads directory (relative or absolute)
WP_UPLOADS_DIR=../wordpress/wp-content/uploads

# Tuning
BATCH_SIZE=5000                # Rows per batch for bulk inserts
MEDIA_CONCURRENCY=10           # Parallel S3 uploads
LOG_LEVEL=info                 # winston level (debug, info, warn, error)
```

Every checkpoint, ID map, manifest, report, temporary-media path, exclusion
list and log is profile-scoped. Do not point two country profiles at the same
`MIGRATION_STATE_DIR`. Table prefixes may contain only letters, numbers and
underscores and must end in `_`; an unsafe prefix fails before MySQL executes
a query.

The India profile keeps using the legacy `.checkpoints/` directory when it is
the only location containing real JSON state. Resolving configuration never
renames or deletes a directory. Move `.checkpoints` to `.state/india` manually
only while no migration command is running. If both locations contain
checkpoints or maps, the run fails and asks the operator to reconcile them. A
target Site Configuration whose country disagrees with the active profile is
also refused before data is mutated.

For USA, copy values from `.env.migration.usa.example` only after explicitly
setting the USA `PG_CONNECTION_STRING`, WordPress host/database/uploads and S3
destination. Do not append the overlay blindly to an India environment.

3. Install dependencies:

```bash
npm install
```

---

## How to Run

```bash
# Full migration (resumes from last checkpoint)
npm run migrate

# Reset all checkpoints and re-run everything
npm run migrate -- --clean

# Reset everything, including media records and the configured S3 prefix
npm run migrate -- --clean --delete-media

# Run a single phase by name
npm run migrate -- --phase 07-coupons

# Reset checkpoints and run a single phase
npm run migrate -- --clean --phase 05-pools

# Resume an interrupted taxonomy phase at the failed term (inclusive)
npm run migrate -- --phase 03-taxonomies --resume-from-term 4234

# Continue phases 08a–15 when individual Deals fail. Phases 08 and 12 remain
# uncheckpointed when affected so those Deals are retried on the next run.
npm run migrate -- --allow-partial-deals

# After a partial Phase 08 run, continue from Phase 12 without rerunning
# Phase 08 or making another background-removal API attempt.
npm run migrate -- --phase 12-offer-backfill --allow-partial-deals
npm run migrate -- --phase 13-site-content
npm run migrate -- --phase 13b-footer-media
npm run migrate -- --phase 13c-footer-country-links
npm run migrate -- --phase 13d-site-selection-backfill
npm run migrate -- --phase 14-media-optimize
npm run migrate -- --phase 15-media-formats-backfill
```

`--allow-partial-deals` is an explicit recovery mode. Strict fail-fast
behavior remains the default. The failed WordPress post IDs stay visible in
the error log, later phases continue, and affected Deal-dependent phases
deliberately receive no checkpoint. After fixing the reported Deals, run the
migration normally to retry them.

> ⚠️ **`--clean` is destructive — it is a full reset, not a checkpoint reset.**
> Before any phase runs it deletes the checkpoint files, deletes **all six ID
> map files** (`clearAllMaps()` in [`src/utils/id-maps.ts`](./src/utils/id-maps.ts)
> unlinks every `*Map.json`), `TRUNCATE ... RESTART IDENTITY CASCADE`s every
> migrated non-media table — entities, link tables, component tables, **and
> the homepage/menu/footer/global singles** — and deletes registry-owned
> `admin_users` rows created by phase 06a. The `files` rows and S3 objects are
> preserved by default, allowing the on-demand uploader to reuse media by
> source hash without optimizing or uploading it again. A retained AWS record
> is reused only after its immutable master key is confirmed with S3; if that
> object is missing, the source is processed and uploaded again and the same
> `files` row is repaired. Add
> `--delete-media` together with `--clean` to delete the `files` rows and empty
> the configured S3 prefix; `--delete-media` is rejected on its own.
> The exact destroy list is enumerated in
> [FRESH-MIGRATION.md § What `--clean` destroys](./FRESH-MIGRATION.md#what---clean-destroys).
>
> `clearCheckpoints()` on its own does preserve `*Map.json` (and logs that it
> did), but the `--clean` branch calls `clearAllMaps()` immediately afterwards,
> so the net effect is that no relationship data survives. To re-run one phase
> against existing data, use `--phase <name>` **without** `--clean`.
>
> An interrupted Phase 03 can avoid reconciling/upserting all earlier terms
> with `--resume-from-term <term_id>`. The named term is processed again
> because its entity row may have been inserted before media or components
> failed. This flag is rejected with `--clean`.

### S3 scan versus deletion logs

These messages are read-only availability checks. They do **not** delete AWS
objects:

```text
S3 media delta: indexing existing objects under uploads/...
S3 media delta progress: page=1, indexed=1000, more=yes
S3 media delta: indexed 9590 existing object(s) under uploads/
Deal image availability progress: 100/748 checked
```

AWS deletion is limited to explicit cleanup paths and uses clearly different
messages:

- `--clean` alone logs `Preserved media records and S3 objects...` and does
  not delete media.
- `--clean --delete-media` logs `--delete-media specified...`,
  `Clearing S3 bucket ...`, and finally
  `S3 cleanup complete: N objects deleted`. It refuses to clear an empty
  `S3_ROOT_PATH`, preventing a whole-bucket deletion.
- Phase 08a deletes an old opaque Deal image only after its transparent
  replacement is linked and the old file has no remaining references. Its
  progress is logged as `[deal-image cleanup ...] deleted=N, retained=N`.
- Phase 14 may delete a superseded JPEG/PNG master after the replacement WebP
  and database update succeed. Its summary reports `deleted old objects=N`.
  Pass `--keep-originals` to disable those Phase 14 deletions.

If Phase 06 is interrupted, keep the Phase 05 checkpoint and ID-map files and
restart only the code phase:

```bash
yarn migrate:phase 06-codes
```

Phase 06 uses WordPress ID keyset pagination and transactional, idempotent
upserts. Existing codes and correct pool links become no-ops, redeemed codes
stay redeemed, and the phase checkpoint is written only after the complete
code inventory succeeds. After it finishes, `yarn migrate` resumes the later
phases normally.

Logs are written to:
- **Console** — colorized, timestamped
- `migration.log` — full log
- `migration-errors.log` — errors only

---

## Migration Phases

The migration runs sequential phases (00–16, including compatibility phases)
in the order declared in [`src/index.ts`](./src/index.ts). Each phase
checkpoints on completion so the process can resume after interruption —
except the explicitly re-runnable validation/backfill/cleanup phases, which are
marked `skipCheckpoint` and therefore always run.

### Phase 00 — Preflight

Validates the profile name and JSON, ISO country/locale/currency/timezone,
WordPress table prefix, both database connections, required prefixed tables,
optional pool/code/Yoast tables, exclusions, expected source inventory and the
target Site Configuration country. These checks happen before target mutation.
It then verifies Strapi infrastructure, creates and validates every unique
index used by entity, media and Coupon/Deal relation `ON CONFLICT` clauses, and
prints the source summary. A drifted Logo Store or taxonomy link table therefore
fails here instead of halfway through a batch. Never checkpointed — always
runs.

### Phase 01 — Media Inventory

Queries all WordPress image attachments. Builds an in-memory catalog with file path, MIME type, alt text, and dimensions. Filters out plugin directories (backup, ninja-popups, elementor, wpallimport, etc.).

### Phase 02 — Media Upload to S3

Uploads inventoried images to S3 with configurable concurrency. Deduplicates by SHA-256 hash. Before upload, supported raster images (jpeg/png/webp/avif/tiff) are optimized: EXIF orientation baked in, downscaled to fit 1920×1920, jpeg/png converted to webp, and webp/avif/tiff re-compressed at quality 80. Strapi-style responsive variants (`thumbnail`/`xsmall`/`small`/`medium`/`large`) are generated and uploaded alongside the original, and recorded in the `files.formats` JSON column. For webp originals, AVIF "twin" variants (`original_avif`/`xsmall_avif`/`small_avif`/`medium_avif`/`large_avif`, quality 50, effort 4) are also encoded — from the pre-optimization source bytes for best quality — and merged into `formats`; a twin that comes out no smaller than its webp counterpart is dropped. All breakpoint/quality knobs live in [`src/constants/image.ts`](../src/constants/image.ts), the single source of truth shared with admin uploads. gif/svg/other formats pass through untouched (`formats` stays NULL). Creates corresponding records in the Strapi `files` table with CloudFront URLs, dimensions, and provider metadata. See [Media / S3 Pipeline](#media--s3-pipeline) for details.

The complete existing `files` rows are preloaded once, not queried once per
logo. Concurrent references to the same path or the same source-byte hash share
one promise, so they cannot transform or upload the same image twice.

### Phase 03 — Taxonomies

Migrates WordPress category terms into **four** Strapi collections — `stores`, `brands`, `categories`, `banks`. USA uses the approved Excel classification workbook matched by slug; SQL terms absent from the workbook default to Store. Profiles without a workbook use ACF `choose_type` with the same Store fallback. Also migrates FAQ items and SEO components for each entity, and links logo/icon media. Images embedded in term descriptions are rewritten through the content-media pipeline (see below).

Before starting the workers, the phase validates manifest entries against the
objects that still exist in S3 and restores all reusable missing Strapi `files`
rows with a few bulk inserts. It does **not** download, transform, or upload
those images again. Slugs are claimed serially first, then taxonomy rows run
with bounded concurrency (`TAXONOMY_CONCURRENCY`, default/max `8`, also clamped
to `PG_POOL_MAX - 2`). All database
writes for one taxonomy are committed in one transaction; media resolution is
completed before that transaction opens. Empty FAQ and description-media
reconciliation is skipped only when a one-time target snapshot proves there is
nothing stale to remove, so reruns still converge correctly. Progress is logged
after every 10 completed rows and at completion. If one term fails, the phase
waits for every already-started worker to settle before reporting the combined
failure, so no background transaction survives the phase boundary.

Bulk restore intentionally makes manifest media available to later phases as
well as taxonomies. After every migration phase succeeds, Phase 16 identifies
unused rows specifically by the deterministic `manifest-file:<hash>` document
identity. It excludes those rows from the S3 reference set and prunes them only
after the normal dry-run and 40% mass-deletion fuse pass. Unlinked media created
by Strapi or an editor is never selected by this ownership boundary.

On a fresh target, a large manifest can legitimately leave more than 40% of
its restored objects unreferenced, so the Phase 16 fuse may stop cleanup. Do
not immediately add `--force-orphan-cleanup`: first verify the active profile,
Postgres target, bucket/root path, linked-media counts and the reported sample.
Use the force flag only when that reviewed deletion set is expected.

### Phase 05 — Unique Coupon Pools

Migrates `wp_uc_coupons` rows into `unique_coupon_pools`, including computed `total_codes` and `used_codes` counts. Skipped if the source table doesn't exist.

### Phase 06 — Unique Codes

Migrates `wp_uc_codes` into `unique_codes` in batches (default 5,000). Links each code to its pool via the `unique_codes_pool_lnk` table. Handles PostgreSQL parameter limits by sub-batching link inserts.

### Phase 06a — Users

Migrates `wp_users` into Strapi `admin_users`, giving every migrated author an
account so the admin's "Created by" / "Updated by" columns are meaningful. Each
account gets a deterministic prefixless 24-character `document_id` and an
ownership entry in `migration_source_entities` (which lets `--clean` remove
only migrated accounts, so the real super admin survives), a random unusable
password plus a reset token — nobody can log in until they use the
password-reset flow — and the `strapi-editor` role. The phase **fails fast** if
that role does not exist (boot Strapi once so its default roles are created).
Users without an email are skipped. Every mapping is recorded in `userIdMap`;
the phase then backfills `created_by_id`/`updated_by_id` on already-migrated
rows, using the WP post author for coupons/deals and, for taxonomy rows (which
WP does not track an editor for), the author of the term's most recently
modified post.

### Phase 07 — Coupons

Migrates WordPress posts where `is_deal` is not `'yes'` into the `coupons`
table. Only non-expired `publish` and `future` rows are included;
`draft`/`trash` rows never import. On
re-import, migration-owned Coupon rows no longer in that source inventory are
removed, so deletion, withdrawal, and Coupon → Product Deal changes converge.
For each coupon:

- Strips WordPress shortcodes from content
- Extracts locale-aware offer and benefit amounts. USA currency cashback such
  as `USD 15 Cashback`, `usd 15 cashback`, `$15 Cashback`, or `Cashback: $15`
  is stored as the bare `$15` value; the public API adds the `Cashback` suffix
  when rendering.
- For profiles with enabled Offer Countries, extracts explicit country/region
  names from the title and content into `offer_countries`. Ambiguous bare ISO
  codes and merchant/product wording such as Air Jordan or Global Village are
  intentionally not treated as country validity.
- Resolves `coupon_type` ("static" or "unique") from ACF meta
- Wires taxonomy relationships (store, brand, category, bank) from WordPress `wp_term_relationships`
- Links the unique coupon pool and SEO component; Coupon records do not own a
  featured image
- Rewrites content-embedded images (see **Content-embedded images** below)

Phase 07 preloads whether existing Coupons have content-media or unique-pool
links. Source/content preparation runs with bounded concurrency
(`COUPON_CONCURRENCY`, default/max `8`) before PostgreSQL writes. Prepared rows
are grouped into batches (`COUPON_BATCH_SIZE`, default `250`, max `500`) and up
to four batches write concurrently (`COUPON_BATCH_CONCURRENCY`, default/max
`4`). `PG_POOL_MAX` defaults to `10`; preparation plus batch concurrency is
automatically reduced when necessary so two connections remain available.
This keeps the importer plus two live five-connection Strapi pools at 20,
below the current managed-Postgres limit of 22. Raise the migration pool only
when Strapi is stopped or the database has independently verified headroom.
Each batch atomically bulk-upserts Coupon rows, migration ownership,
taxonomy/Logo Store links, content media and pool links. Empty content-media or
pool cleanup is skipped only when the target snapshot proves no stale row
exists. A data or constraint error recursively splits only its affected batch,
so one corrupt source record can be reported without discarding valid records;
connection and SQL errors still abort the phase. Progress and throughput are
logged after every completed batch. This preserves idempotency while reducing
the normal remote path to a handful of round trips per 250 Coupons.

For Coupons-only profiles, Phase 08 and the Deal-reconciliation portion of
Phase 12 are valid no-ops. Phase 12 still runs the Coupon recommendation
backfill. Its empty-target continuity guard fails only when importable source
Deals exist but the target `deals` table is unexpectedly empty.

#### Content-embedded images

Rich-text HTML (`coupons.content`, `deals.content`, taxonomy `description`) can reference images directly via `<img src>` / `srcset` / lightbox `<a href>` URLs pointing at `wp-content/uploads/`. `utils/content-media.ts` rewrites every such reference:

1. The URL is normalized — query strings dropped, percent-encoding decoded, WP size suffixes (`-300x200`) and `-scaled` variants collapsed to the original file.
2. The path is resolved to an attachment ID via a `_wp_attached_file` reverse index and uploaded on demand through the same optimize/S3 pipeline as Phase 02 (deduplicated by content hash and in-flight path).
3. Files present in the uploads dir but missing a WP attachment row are uploaded straight from disk.
4. `<img>` tags are rebuilt with the new optimized URL plus a responsive `srcset`/`sizes` built from the generated Strapi formats; other uploads URLs are swapped in place.
5. Referenced files are linked in `files_related_mph` so Phase 11 treats them as used; unresolved URLs are left untouched and listed in the end-of-run stats. Phase 10 reports any rows still containing `wp-content/uploads` references.

### Phase 08 — Deals

Migrates deal posts (`is_deal='yes'`) into the `deals` table using the same
non-expired publish/future lifecycle rule as Coupons. Re-import
removes migration-owned Deal rows that were withdrawn, deleted, or changed back
to Coupons. Relationship wiring is the same as Coupons, plus deal-specific
fields: `mrp`, `sale_price`, `discount`, and `dealImage`. The `deal_store` meta
is merged into the `stores` relation (deduplicated against taxonomy-linked
stores). Brand-linked Deals follow the same affiliate rule as Coupons:
`is_for_affiliate_brand` is `true` and the mutually-exclusive Store/Logo Store
relations are cleared (phase 12's reconciliation applies the identical rule).

### Phase 09 — SEO Backfill

Scans all six entity tables for rows missing an SEO component. Attempts to fill from `wp_yoast_indexable` data, resolving Yoast template variables.

### Phase 10 — Verification

Compares record counts between source and destination using the same offer
lifecycle inclusion rule as phases 07/08, checks relationship integrity,
validates slug uniqueness, reports SEO coverage percentages, and runs sample
spot checks. Never checkpointed — always runs. Failures are logged but
non-fatal.

### Phase 11 — Copy Used Media

Copies only the media files actually referenced by entities (via `files_related_mph`) into Strapi's `public/uploads` directory (local-provider files only).

### Phase 12 — Offer Backfill

Reconciles each Deal's complete ordered taxonomy relation set from WordPress.
The ACF `deal_store` term is first in `stores`, followed by the WordPress
taxonomy terms in their source order. Every relation table is
replaced transactionally per Deal, so changed/cleared ACF ownership and stale
links converge to the same result as a clean import.

### Phase 12a — Entity Timestamp Backfill

After Coupon and Deal taxonomy relations are final, derives honest entity-page
timestamps from the offers filed under each Store, Brand, Category, and Bank:
`created_at` becomes the earliest related offer creation date and `updated_at`
becomes the latest related offer modification date. Only currently rendered
offers (`content_status = published` and not expired) participate; scheduled
and expired offers cannot move a page's sitemap `lastmod`. Entities without
visible related offers are left unchanged.

This is intentionally a pre-launch operation: WordPress is still the sole
source of truth, so it replaces the import-generated Strapi system timestamps.
Do not rerun it after editors begin changing entities in Strapi. In
`--allow-partial-deals` mode phase 12a is deliberately not checkpointed, so a
later successful Deal retry can converge the derived entity timestamps during
the migration.

### Phase 12b — Offer Relevance Timestamp Backfill

Sets `published_on`, the editor-controlled relevance/"bump to top" timestamp,
from the migrated WordPress publish date stored in `published_at`. It repairs
every migration-owned Coupon and Deal whose value differs from that source
publish date. Phase 07/08 inserts and reruns also set the field from the
WordPress publish date, so the imported order remains identical to WordPress.
This is a pre-launch migration rule; stop rerunning these phases after editors
begin using Strapi's explicit bump action.

### Phase 13 — Site Content

Seeds the Strapi single types the frontend needs:

- `global` — header/footer codes from WP ACF option keys (`options_header_code`, `options_footer_code`).
- `homepage` — created as a **single published row** (draftAndPublish is disabled on the publish-only homepage, menu, footer, and global single types), with the full component tree built once. Also seeds `title: "Homepage"` for the admin entry header. Curated sections: hero banners from the `options_slider_features` ACF repeater; hero offers prefer migrated Deal entities and fall back to the newest renderable Coupon entities (named Store/Brand owner, routable slug, and real logo) only when no published Deals exist; an existing homepage is editor-owned, except that an empty Hero Offer list is filled without replacing existing selections. Top Deals remain Deal-only; CG Exclusive, Fresh Drops, Explore Offers, and Offers By Brand use Coupon entities; Popular Stores come from `options_featured_stores` (fallback: top stores by published-coupon count); bank offers are ranked by published-coupon count; plus How It Works and FAQ copy mirrored from the frontend. Per-section item counts live in `src/utils/homepage-limits.ts` (each holds a +4 buffer over what the site renders; a parity test pins them to the component schema `max` values).
- `menu` — topStores relation (same curated store list), one shared responsive hierarchy made from explore Categories and their immediate child Categories, and the fixed extra nav items. Desktop renders those sections as mega-menu columns; mobile renders the same ordered groups as icon rows with a child-link drill-down plus the first four configured Top Stores as Popular Stores pills. Section and child-link icons uploaded in Menu override their related Category icons; seeded rows intentionally leave overrides empty so Category icons remain the fallback.
- `footer` — link sections, social links, countries, and partner card mirrored from the frontend `footer-data.ts`; Popular Stores labels are resolved to real store relations where a matching store name exists. Country flag media is attached by Phase 13b.
- `site_configuration` — identity, localization, onboarding state and
  catalog/editorial/legal feature flags loaded from the active profile JSON.
  Campaign activation is never seeded as a boolean; it follows entity
  `pageTemplate` ownership.

The retired Deal-backed Homepage fields `exploreDeals` and `dealsByBrand` are
not seeded, queried, or retained as compatibility fallbacks. Explore Offers
and Offers By Brand use their Coupon-backed fields only.

The USA profile imports five hero banners. Curated Featured Store entries are
linked only when they resolve to migrated Store rows; unmapped entries are
skipped and no automatic replacement Stores are inserted, so Homepage and Menu
store selections can be completed manually. The four old eight-store grids are
reported and intentionally ignored. Recommended/Exclusive/Newly Added Coupon
sections use their WordPress popularity and offer-type values, while sections
requiring a disabled or unavailable catalog type are disabled. Header/footer
tracking scripts are not copied unless `IMPORT_WP_TRACKING_SCRIPTS=true` is
explicitly approved.

All component and relation link table names are verified against `information_schema` before writing; anything missing (schema not migrated yet) is skipped with a clear warning. Each single type is skipped entirely if its table already has a row, so re-runs are safe.

### Phase 13b — Footer Media

Backfills every other site from the shared `profiles/footer-countries.json`
registry, automatically excluding `SOURCE_COUNTRY_CODE`. Google Preferred is
optional per deployment in `profiles/<profile>/footer-settings.json`.
The exact source PNGs live in `assets/footer/` and pass through the same
hash-deduplicated media pipeline as other migration uploads. In S3
environments that means PNG masters are converted to optimized WebP and the
normal responsive WebP/AVIF format ladder is generated before the Strapi media
relations are attached.

The phase is fill-only: existing country flag or Google icon relations are
preserved, missing country/card components are created, and blank Google card
copy is filled with the migration defaults. It has its own checkpoint so
environments where Phase 13 already completed still receive the backfill.
Apply the latest Strapi footer schema before running it.

```bash
npm run migrate -- --phase 13b-footer-media
```

### Phase 13c — Footer Country Links

Backfills the five international CouponzGuru homepage URLs into blank
`footer.country.url` fields. Existing editor-entered destinations are
preserved. This compatibility checkpoint exists for environments that already
completed Phase 13b before the country component gained its URL field.

```bash
npm run migrate -- --phase 13c-footer-country-links
```

### Phase 13d — Homepage and Search Selections

Compatibility backfill for deployments that completed Phase 13 before the
Homepage Popular Searches relations and search-overlay fields were introduced.
It converts legacy Popular Searches links to entity relations, fills an empty
search overlay from the existing top-store ordering plus live-offer popularity,
and preserves every non-empty editor-managed selection.

```bash
npm run migrate -- --phase 13d-site-selection-backfill
```

### Phase 14 — Media Optimize (backfill)

Runs two passes over already-migrated S3 images.

**Pass 1 — full optimize backfill.** Candidates are `files` rows with `provider='aws-s3'`, `formats IS NULL`, and an optimizable MIME type (jpeg/png/webp/avif/tiff). For each candidate (5 in parallel):

1. **Source bytes** — resolved from the local `WP_UPLOADS_DIR` tree via a `sha256(file)[0:16] → path` map (cached as `mediaHashMap.json` in the active profile state directory, keyed by mtime + size so re-runs don't rehash; survives `--clean` like every `*Map.json`), falling back to downloading the current S3 object.
2. **Optimize** — same pipeline as Phase 02: orientation baked, max 1920px, jpeg/png → webp, quality 80. AVIF twins are encoded from the raw source bytes for webp results.
3. **Upload** — the optimized original (new `.webp` key when converted) plus all responsive variants (including AVIF twins).
4. **Update** — a single `UPDATE files SET formats, ext, mime, url, width, height, size, provider_metadata, updated_at` as the **last** step, so a crash leaves the row eligible for the next run (row-level resume via the `formats IS NULL` predicate).
5. **Cleanup** — the superseded S3 object is deleted when the key changed (jpeg/png → webp), unless `--keep-originals` is passed:

```bash
npm run migrate -- --phase 14-media-optimize --keep-originals
```

**Pass 2 — add-AVIF-only backfill.** Candidates are rows that already have `formats` but no `original_avif` key (`formats::jsonb ? 'original_avif'` is false) with MIME webp/jpeg/png. For each row, the source is resolved the same way (local hash map, then S3 object via `provider_metadata.key`), true dimensions are read via `sharp` metadata (falling back to the row's stored width/height), AVIF twins (`original_avif`/`xsmall_avif`/`small_avif`/`medium_avif`/`large_avif`) are encoded and uploaded next to the existing variants, and the new keys are merged into the existing JSON with a single `UPDATE files SET formats = formats || $new`. Idempotent via the missing-`original_avif` predicate; `--keep-originals` is a no-op for this pass.

Fails fast with a clear error if the `files` table is empty (run a full migration first).

### Phase 15 — Media Formats Backfill

Fills gaps in the responsive variant matrix for rows that **already have** `formats`. Phase 14 pass 1 only handles `formats IS NULL` and pass 2 only adds missing AVIF twins, so rows migrated before the `xsmall` (320px) breakpoint or the thumbnail rung existed can never gain those keys from Phase 14. Per row, this phase computes expected − stored − tombstoned keys (`expectedFormatKeys()`), generates **only the missing variants** from the current S3 master (the local WordPress original is used as the AVIF encode source when available), uploads them, and merges the new keys into `formats` with a single jsonb-merge `UPDATE` as the **last** step — a crash leaves the row a candidate for the next run. Skipped with a warning when S3 isn't configured.

**Candidate selection.** The `WHERE` clause is generated by `buildGapWhere()` in [`src/utils/format-gaps.ts`](./src/utils/format-gaps.ts) from the same constants `expectedFormatKeys()` reads, so SQL and JS can never disagree about what "complete" means. Its arms are: one per thumbnail/breakpoint rung (key absent **and** the master exceeds that size), one per AVIF twin for `mime = 'image/webp'` (key absent, due, **and not tombstoned**), and a `width IS NULL OR height IS NULL` arm — three-valued logic silences every comparison arm for a dimensionless row, so those rows need their own arm. NULL-dims rows are selected even when nothing else is missing; their true dimensions are decoded from the master and persisted (counted as `dims backfilled` in the end-of-phase summary), which is what lets them leave the NULL arm instead of being re-fetched on every run.

```bash
npm run migrate -- --phase 15-media-formats-backfill --dry-run    # DB-read-only report
npm run migrate -- --phase 15-media-formats-backfill --limit 50   # pilot run
npm run migrate -- --phase 15-media-formats-backfill --overwrite  # regenerate everything
```

- `--dry-run` — per-row missing-keys report from stored DB values only (no S3 access, no writes). Rows whose stored dimensions are unknown are warned and counted; the real run decides those from the S3 master.
- `--limit N` — process at most N candidate rows.
- `--overwrite` — regenerate **all** expected keys and replace the S3 objects (unconditional puts) instead of only filling gaps. It also **REPLACES** `provider_metadata.avifDropped` with this run's actual drops rather than merging into it — the escape hatch when encoder tuning makes previously-dropped twins viable. Without it, a stale tombstone is permanent.

Behavior notes:

- **Never checkpointed** (`skipCheckpoint`) — re-runnable by design; the candidate SQL is the idempotency guard, and a checkpoint would let a `--dry-run`/`--limit` pilot mark the phase complete.
- **AVIF size guard and its tombstone**: an AVIF twin that comes out no smaller than its webp counterpart is dropped, and the dropped key is recorded in `provider_metadata.avifDropped` **in the same `UPDATE`** that merges the generated keys. Because the candidate SQL excludes tombstoned twins, a re-run after a successful pass selects ~0 rows and fetches ~0 masters — the phase converges. (This is the one behaviour that differs from Phase 14 pass 2, which still re-encodes and re-drops.) The tombstone lives in `provider_metadata` rather than `formats` on purpose: Strapi treats every `formats` entry as a real file when deleting media, so a marker there would break its delete iteration. Rows whose only persisted outcome was a tombstone are reported as `skipped (avif larger)`.
- **Shared masters**: rows resolving to the same S3 master form a group — the master is fetched and dimension-decoded **once**, and generated entries plus dropped keys are shared across the group — but each row still computes and merges its **own** missing set (reported as `reused shared` when a row is satisfied entirely by a groupmate's work). `provider_metadata` is written wholesale from a JS-side merge, so **never run this phase concurrently with Phase 14**.
- **S3 master resolution**: `provider_metadata.key` when present (migration rows always carry it); otherwise the aws-s3 provider convention `{rootPath}/{hash}{ext}` is tried first, then the legacy migration-era flat `{rootPath}/{hash}_{name}{ext}`. The candidate that hits defines where new variants land.
- **Conditional PUT**: variant uploads use `IfNoneMatch: "*"` so re-runs never rewrite bytes already placed — a 412 response means a previous run uploaded the object and counts as success. Endpoints that answer `NotImplemented` (non-AWS S3 implementations) flip the rest of the run to unconditional puts.
- **Partial failure is visible**: due keys that were neither generated nor guard-dropped are encode failures. Whatever succeeded is still persisted, the row stays eligible for the rest, and the run counts it as `failed` rather than hiding it in a success bucket.

Content HTML srcsets are frozen at migration time, so rich-text `<img>` tags don't automatically pick up backfilled variants — run `npm run fix:content-srcsets` afterwards if that parity matters (see [Maintenance scripts](#maintenance-scripts)).

---

## Data Mapping

### Taxonomies (Phase 03)

WordPress stores all taxonomy terms in `wp_terms` with `taxonomy='category'`.
For USA and UAE, `MIGRATION_CLASSIFICATION_FILE` points to the approved Excel workbook;
its `Classification` value is matched to the SQL term by exact normalized
slug. Excel is authoritative, and SQL slugs absent from the workbook default
to Store. Other profiles use ACF `choose_type` with the same fallback. The UAE
workbook contains 1,397 importable rows: 457 Stores, 862 Brands and 78
Categories. Its one omitted SQL term, `Expired`, is excluded through the UAE
profile because it is a WordPress lifecycle bucket rather than a catalog entity.

| Classification / `choose_type` | Strapi table |
|--------------------------------|-------------|
| `Store` (default)   | `stores`    |
| `Brand`             | `brands`    |
| `Category`          | `categories`|
| `Bank`              | `banks`     |
| `Article`/`Articles` | **not imported** — editorial content, skipped entirely |

The approved USA workbook contains 7,169 unique classified slugs (542 Store,
6,552 Brand, 68 Category, 7 Bank). Against the 2026-08-30 SQL, 7,119 match;
50 obsolete workbook rows are reported, while 10 new SQL terms default to
Store. `Uncategorized` is then excluded, producing 549 Stores, 6,504 Brands,
68 Categories, and 7 Banks.

**Import exclusions** (`src/utils/import-exclusions.ts`) — three rules, all
applied in phases 03/07/08 and mirrored by phase 10's expected counts:

1. **Articles category**: the term with slug `articles` / name `Articles`
   (case-insensitive; an `Article(s)` choose_type also counts) plus every
   descendant term under it.
2. **Uncategorized**: the exact WordPress fallback category (name or slug,
   case-insensitive). The term and every post filed under it are excluded.
3. **Optional retired stores**: when `MIGRATION_EXCLUSIONS_FILE` points to an
   operator-supplied CSV, its store names are matched case/whitespace-
   insensitively against terms whose `choose_type` is `Store` or missing (a
   Brand/Bank/Category sharing a name is never swallowed). The repo
   intentionally ships no historical retired-store CSV for India or USA. The
   UAE profile uses this same exclusion seam for its non-catalog `Expired`
   bucket; an unset or missing file means zero listed exclusions.

An excluded term is never imported, and every post filed under one is
excluded from phases 07/08 — *before* the inventory reconciliation, so a
re-import also deletes posts a previous run imported. Skipped posts' media is
never uploaded (uploads are on-demand); phase 16 removes previously-uploaded
objects as orphans.

**Dry run**: `yarn migrate:report` (read-only, WordPress only) prints how
many stores/brands/categories/banks and how many coupons/deals would import
after all exclusions, plus the expired/excluded breakdown — and writes three
CSVs: `migration/dry-run-report.csv` (one row per imported term: type,
associated coupon/deal counts, dropped counts, valid remainder),
`migration/dry-run-excluded.csv` (one row per EXCLUDED term — articles /
Uncategorized / retired stores — with the coupon/deal counts its exclusion
deletes, plus a row per listed name that matched no WP term), and
`migration/dry-run-summary.csv` (the expired and taxonomy-exclusion funnel).

**Field mapping:**

| WordPress | Strapi | Notes |
|-----------|--------|-------|
| `name` | `name` | |
| `slug` | `slug` | Deduplicated per table (appends `-1`, `-2`, etc.) |
| `description` | `description` | |
| `store_short_description` (termmeta) | `short_description` | |
| `store_cat_image` (termmeta) | `logo` / `icon` | Media link via `files_related_mph` |
| `store_image_alt` (termmeta) | `logo_alt` | Stores, brands, banks only |
| `enable_faq_schema` (termmeta) | `faq_enabled` | Boolean (`'1'` → true) |
| Excel `Brand` classification | `is_affiliate_store` | Seeded `true` on the imported Brand; fill-only on re-import so an editor's panel toggle wins |

### Posts: Coupons vs Deals (Phases 07–08)

WordPress posts with `post_type='post'` are first filtered by lifecycle:
only non-expired `publish`/`future` rows are included — `draft`/`trash` and
rows whose valid expiry is at or before the migration time never import. They
are then split:

- **Deal** — `is_deal` postmeta = `'yes'` → `deals` table
- **Coupon** — everything else → `coupons` table

**Common field mapping (both coupons and deals):**

| WordPress | Strapi | Notes |
|-----------|--------|-------|
| `post_title` | `title` | |
| `post_name` | `slug` | Deduplicated |
| `post_content` | `content` | Shortcodes stripped; Deal rows additionally reject price/code values and empty rich-text wrappers |
| `code` (postmeta) | `code` | Coupon code string |
| `link` (postmeta) | `affiliate_link` | |
| `popular_coupon` (postmeta) | `is_popular` | `'1'` → true |
| `unique_coupon` (postmeta) | `coupon_type` | `'1'`/`'true'` → `"unique"`, else `"static"` |
| `unique_coupon_name` (postmeta) | `uniqueCouponPool` relation | Resolved by pool name for unique coupons |
| Expiration meta* | `expires_at` | Unix timestamp or ISO date |
| `post_date` | `published_at` | |
| Related Excel-classified Brand | `is_for_affiliate_brand` + `brands` | Coupon flag is `true`, Brand relation is retained, and mutually-exclusive Store/Logo Store relations are cleared; Coupons without Brands are explicitly `false` |

*Expiration checked in order: `_action_manager_date`, `_expiration-date`, `expiration-date`.

**Deal-specific fields:**

| WordPress | Strapi | Notes |
|-----------|--------|-------|
| `deal_mrp` | `mrp` | Decimal |
| `deal_sale_price` | `sale_price` | Decimal |
| `deal_discount` | `discount` | String |
| `deal_image` | `dealImage` | Media link (falls back to `image`) |
| `deal_store` | `stores` | Merged into `stores` relation (dedup against taxonomy terms) |

### Taxonomy Relationship Wiring

Coupon/deal taxonomy links come from WordPress `wp_term_relationships`; Yoast primary-term metadata is not treated as membership. Deal `deal_store` remains an explicit owning-store override and is ordered first.

### Unique Coupon Pool / Code Mapping

| WordPress | Strapi |
|-----------|--------|
| `wp_uc_coupons` | `unique_coupon_pools` (name, total_codes, used_codes) |
| `wp_uc_codes` | `unique_codes` (code, is_used) → linked to pool |
| `unique_coupon` | `coupon_type='unique'` when truthy |
| `unique_coupon_name` | `coupons_unique_coupon_pool_lnk` via `wp_uc_coupons.name` |

Coupons with `coupon_type='unique'` are linked to their pool via `unique_coupon_name`, which matches the WordPress theme flow and resolves against `wp_uc_coupons.name`.

---

## Media / S3 Pipeline

### Phase 01 — Inventory

1. Query all WordPress attachments with image MIME types
2. Extract relative file path from the attachment GUID
3. Fetch alt text from `wp_postmeta`
4. Filter out plugin directories (backup, ninja-popups, elementor, etc.)
5. Verify the file exists on disk at `WP_UPLOADS_DIR/{relative_path}`

### Phase 02 — Upload & Register

For each image (uploaded on demand the first time content references it):

1. **Hash** — SHA-256 of the source file bytes, truncated to 16 characters. Computed before any optimization, so dedup/idempotency is unaffected by re-encoding.
2. **Dedup check** — skip if the hash already exists in the Strapi `files` table (the existing record is reused)
3. **Optimize** — supported raster formats (jpeg/png/webp/avif/tiff) go through `optimizeOriginal`: EXIF orientation baked, capped at 1920×1920, jpeg/png converted to webp, webp/avif/tiff re-encoded at quality 80. gif/svg/animated/undecodable images pass through untouched.
4. **S3 key** — `{S3_ROOT_PATH}/{slug}-{hash[0:8]}/{slug}{ext}`: one folder per image (keyword-first slug + short content hash) so the original and all generated variants live together; only the extension changes on webp conversion
5. **Upload** — PUT to S3 with `Cache-Control: public, max-age=31536000, immutable`. SVG/markup-capable MIME types are stored as `application/octet-stream` with an attachment disposition so they can never execute inline.
6. **Variants** — `generateStrapiFormats` renders the responsive matrix (`thumbnail`/`xsmall`/`small`/`medium`/`large`, each key only when the master exceeds that size) plus AVIF twins for webp masters, uploads every variant next to the original, and returns the `files.formats` JSON
7. **Register** — insert into Strapi `files` table:
   - `document_id`: CUID v2
   - `url`: `{S3_BASE_URL}/{s3Key}` (or AWS default URL)
   - `provider`: `"aws-s3"`
   - `provider_metadata`: JSON with S3 key
   - `formats`, `hash`, `name`, `alternative_text`, `caption`, `width`, `height`, `ext`, `mime`, `size`
8. **ID map** — store `WP attachment_id → Strapi file_id` for later linking

If `S3_BUCKET` is empty, optimization is skipped entirely — files are registered as local provider records with `/uploads/{hash}_{name}{ext}` URLs and `formats` stays NULL.

### Product Deal images (Phase 08 / 08a)

Product Deal images bypass the generic opaque upload path. The migration reads
the WordPress/current source and computes its content hash. It first checks for
a valid PNG with that hash in the local transparent archive. A cache hit skips
FAL and goes directly through WebP/AVIF optimization and S3 upload. On a cache
miss it removes the background with FAL Bria RMBG 2.0 (already-transparent
sources also skip the API), validates the returned PNG, and atomically archives
that lossless master under
`background-removed-deal-images/fal-bria-rmbg-2.0-v1/`. Only after reading the
archive back does it generate WebP/AVIF files and upload those transparent
outputs to S3.

The archive is gitignored and deliberately survives `--clean`. Re-imports use
the source-hash filename and make no repeated FAL call. Phase
`08a-deal-image-backgrounds` is re-runnable and also converts Deal images that
already existed in Strapi. When it replaces an opaque AWS file, it deletes the
old object only if `files_related_mph` confirms that no content still references
it.

Credit, authentication, rate-limit, timeout, or invalid-output failures stop the
affected phase without linking an opaque image. After fixing the provider issue,
resume with:

```bash
npm run migrate:phase -- 08a-deal-image-backgrounds
```

### Maintenance scripts

The non-phase scripts in this package repair already-uploaded media or
already-migrated content in place. They default to **dry-run** and refuse to
write without `--apply` plus an explicit confirmation flag naming the target
(`--yes-i-mean-<pg-host>`, or `--yes-i-mean-<bucket>` for
`fix:cache-headers`); full runbook entries live in
[FRESH-MIGRATION.md § Maintenance scripts](./FRESH-MIGRATION.md#maintenance-scripts).
The media-related scripts are described here because they are part of this
pipeline:

- `npm run fix:cache-headers` — stamps `Cache-Control: public, max-age=31536000, immutable` on every already-uploaded S3 object via an in-place `CopyObject` (`MetadataDirective: REPLACE`) that carries the stored Content-Type/Disposition/Encoding/Language, user metadata, storage class, and SSE settings through unchanged. Objects already carrying the value are skipped, so re-runs are cheap. Write flag: `--apply --yes-i-mean-<bucket>`.
- `npm run fix:content-srcsets` — rebuilds `srcset`/`sizes` on migrated rich-text `<img>` tags from the current `files.formats` (e.g. after Phase 15 adds missing variants). Only tags whose `src` exactly matches a `files.url` master URL are touched; the rest are logged and left as-is. Write flag: `--apply --yes-i-mean-<pg-host>`.

The content/schema repair scripts include `fix:markdown-richtext`,
`backfill:taxonomy-descriptions`, `backfill:offer-fields`, and
`cleanup:legacy-fields` (plus `src/reset-homepage.ts`, run through `tsx`); see
[FRESH-MIGRATION.md § Maintenance scripts](./FRESH-MIGRATION.md#maintenance-scripts).

### Media Linking

When a phase needs to attach media to an entity or presentation component
(e.g., a store logo or homepage Coupon banner), it:

1. Resolves the WP attachment ID or URL via `resolveMediaRef()` → Strapi `file_id`
2. Inserts a row into `files_related_mph` with the entity type, entity ID, and field name

---

## SEO & FAQ Components

### Yoast SEO

SEO data is stored as Strapi components (`components_shared_seos`) linked via `{table}_cmps` join tables.

**Sources** (checked in order per entity):
1. `_yoast_wpseo_title` / `_yoast_wpseo_metadesc` from `wp_postmeta` or `wp_termmeta`
2. `wp_yoast_indexable` table (Phase 09 backfill)

**Yoast template variable resolution:**

| Variable | Resolved to |
|----------|-------------|
| `%%title%%` | Entity title/name |
| `%%sep%%` | `-` |
| `%%sitename%%` | `CouponzGuru` |
| `%%term_title%%` | Entity title/name |
| `%%year%%`, `%%currentyear%%` | Current year |
| `%%page%%`, `%%primary_category%%`, `%%category%%`, `%%tag%%`, `%%excerpt%%`, `%%date%%`, `%%cf_*%%` | Empty string |

Remaining `%%...%%` patterns are stripped. Multiple spaces are normalized.

### ACF FAQ Repeater

FAQ data uses the ACF repeater field format in `wp_termmeta`:

```
faq_items        → "3"                   (count)
faq_items_0_faq_question → "What is...?"
faq_items_0_faq_answer   → "It is..."
faq_items_1_faq_question → "How to...?"
faq_items_1_faq_answer   → "You can..."
...
```

Parsed into `components_shared_faq_items` rows and linked via `{table}_cmps` with `field='faqs'` and `component_type='shared.faq-item'`.

---

## Idempotency & Resume

The migration is designed to be safely re-run after interruption or failure.

> **WordPress is the source of truth until cutover.** Re-running phases 03/07/08
> intentionally refreshes `content` / `description` (and deal prices) on
> existing rows via `ON CONFLICT DO UPDATE` — any edits made to those fields in
> the Strapi admin are overwritten by the freshly migrated WordPress values.
> Once editors start working in Strapi, stop re-running these phases.
>
> Exception — **fill-only columns**: `deals.coupon_type`,
> `show_trending_deals`, and `stores.is_cj_enabled` use
> `COALESCE(existing, EXCLUDED)` instead of bare `EXCLUDED`. WordPress has no
> opinion on these (the import only supplies the schema default), so an
> editor's value always survives a re-run; NULLs from older imports are healed.

### Checkpointing

- Each phase writes a checkpoint file to `<state-dir>/{phase}.json` on completion (`.state/<profile>` by default)
- On restart, completed phases are skipped automatically
- `--clean` deletes the checkpoint files **and every ID map file**, then wipes the target — see the warning under [How to Run](#how-to-run). It is not a resume aid.

### ID Map Persistence

Six maps are serialized to the active profile state directory as JSON by
`saveMaps()` in [`src/utils/id-maps.ts`](./src/utils/id-maps.ts):

| Map | File | Key → Value | What it unlocks |
|-----|------|-------------|-----------------|
| `termIdMap` | `termIdMap.json` | WP term_id → `{id, documentId, type, table}` | Phases 07/08/12 wire coupons/deals to the store/brand/category/bank rows phase 03 created |
| `postIdMap` | `postIdMap.json` | WP post_id → `{id, documentId, type, table}` | Phase 12 backfills relations for exactly the posts that were migrated |
| `mediaIdMap` | `mediaIdMap.json` | WP attachment_id → Strapi file_id | Every media link (`files_related_mph`) resolves without re-uploading |
| `poolIdMap` | `poolIdMap.json` | WP pool_id → `{id, documentId, type, table}` | Phase 06 links `unique_codes` to their pool |
| `poolNameMap` | `poolNameMap.json` | WP pool name (raw **and** lowercased) → `{id, documentId, type, table}` | Phase 07 resolves `unique_coupon_name` to a pool, which is how the WP theme addressed pools |
| `userIdMap` | `userIdMap.json` | WP `user_id` → `admin_users.id` | Phases 07/08 stamp `created_by_id`/`updated_by_id` from the WP author and `_edit_last` without re-running phase 06a |

Maps are loaded at startup (`loadMaps()`, each file independently optional) and saved after each phase, so a later phase run standalone via `--phase` can still reference IDs created by earlier ones. `termIdMap` additionally has a DB-backed fallback (`ensureTermMapping()` resolves by the deterministic `term:{table}:{wp_term_id}` document_id), so taxonomy lookups survive a lost map file; the other five do not.

### Database-Level Idempotency

- Localized taxonomy, Coupon and Deal source rows are written with
  `locale = 'en'` and upsert with `ON CONFLICT (document_id, locale)`. Their
  database uniqueness is locale-aware because every translated row shares the
  same logical `document_id`. Non-localized pools, unique codes and files keep
  `ON CONFLICT (document_id)`.
- `document_id` for migrated WordPress entities is deterministic and derived from stable source keys:
  - terms: `term:{table}:{wp_term_id}`
  - pools: `pool:{wp_pool_id}`
  - codes: `unique-code:{wp_uc_codes.id}`
  - coupons: `coupon:{wp_post_id}`
  - deals: `deal:{wp_post_id}`
- On rerun, phases resolve the existing entity by `document_id` and rebuild in-memory ID maps instead of reinserting duplicates
- Link table inserts use `ON CONFLICT DO NOTHING`
- Media uploads check existing hashes before uploading
- Per-item `try/catch` in loops logs errors and continues

### Slug Deduplication

Per-table in-memory tracking prevents duplicate slugs. Collisions get a `-1`, `-2`, etc. suffix appended.

---

## Verification

Phase 10 runs a comprehensive validation suite (always runs, never checkpointed):

1. **Record counts** — compares source (WordPress) vs destination (Strapi) counts for all entity types: stores, brands, categories, banks, coupons, deals, pools, codes
2. **Relationship integrity** — flags coupons/deals with no taxonomy links
3. **Slug uniqueness** — warns on duplicate slugs within each table
4. **SEO coverage** — reports the percentage of entities with SEO components per table
5. **Spot checks** — samples random stores and coupons with full detail output

All checks log results but are non-fatal — the phase runs to completion regardless of failures.

The report is profile-scoped and uses the same exclusions and quarantine
decisions as the import. For the USA profile, also reconcile 7,162 Stores,
10,360 attachments, zero Product Deals, five hero banners and eight featured
Stores, with every remaining source WordPress ID accounted for as imported,
normalized, excluded or quarantined.
