# CouponzGuru Migration: WordPress + ACF Pro to Strapi 5

Migrates the full CouponzGuru WordPress site (posts, taxonomies, media, SEO, unique coupon codes) into a Strapi 5 PostgreSQL backend with S3-hosted media.

> **Running a migration into a new environment?** Follow the operator checklist in [FRESH-MIGRATION.md](./FRESH-MIGRATION.md) — this README is the reference for what each phase does internally.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Setup & Configuration](#setup--configuration)
- [How to Run](#how-to-run)
- [Migration Phases](#migration-phases)
- [Data Mapping](#data-mapping)
- [Media / S3 Pipeline](#media--s3-pipeline)
- [SEO & FAQ Components](#seo--faq-components)
- [Idempotency & Resume](#idempotency--resume)
- [Verification](#verification)

---

## Prerequisites

| Dependency | Details |
|------------|---------|
| **Node.js** | v18+ with `tsx` available (used to run TypeScript directly) |
| **MySQL** | WordPress database dump loaded (tables: `wp_posts`, `wp_postmeta`, `wp_terms`, `wp_term_taxonomy`, `wp_term_relationships`, `wp_termmeta`) |
| **PostgreSQL** | Strapi 5 database with tables already created by Strapi (stores, brands, categories, banks, coupons, deals, unique_coupon_pools, unique_codes, files, component tables, link tables) |
| **AWS S3** | Bucket + credentials for media uploads (optional — falls back to local provider records) |
| **WordPress uploads** | Local copy of `wp-content/uploads/` for image file access |

Optional WordPress tables: `wp_uc_coupons`, `wp_uc_codes` (unique coupon plugin), `wp_yoast_indexable` (SEO backfill).

---

## Setup & Configuration

1. Copy the environment template and fill in your values:

```bash
cp .env.migration.example .env.migration
```

2. Configure the following variables in `.env.migration`:

```ini
# WordPress MySQL
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

# AWS S3 (leave S3_BUCKET empty to use local file records)
S3_BUCKET=
S3_REGION=ap-south-1
S3_ACCESS_KEY_ID=
S3_ACCESS_SECRET=
S3_BASE_URL=                   # CloudFront / CDN URL (optional)
S3_ROOT_PATH=uploads           # Key prefix in bucket
S3_ENDPOINT=                   # Custom endpoint for Minio, etc.

# Local WordPress uploads directory (relative or absolute)
WP_UPLOADS_DIR=../wordpress/wp-content/uploads

# Tuning
BATCH_SIZE=5000                # Rows per batch for bulk inserts
MEDIA_CONCURRENCY=10           # Parallel S3 uploads
LOG_LEVEL=info                 # winston level (debug, info, warn, error)
```

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

# Run a single phase by name
npm run migrate -- --phase 07-coupons

# Reset checkpoints and run a single phase
npm run migrate -- --clean --phase 05-pools
```

The `--clean` flag deletes checkpoint files but **preserves ID map files**, so relationship data from earlier phases is retained.

Logs are written to:
- **Console** — colorized, timestamped
- `migration.log` — full log
- `migration-errors.log` — errors only

---

## Migration Phases

The migration runs sequential phases (00–14, including compatibility phase 13a). Each phase checkpoints on completion so the process can resume after interruption.

### Phase 00 — Preflight

Validates both database connections and checks for required tables. Prints a data summary: term counts by type, post counts (deals vs coupons), attachment count, and optional pool/code counts. Never checkpointed — always runs.

### Phase 01 — Media Inventory

Queries all WordPress image attachments. Builds an in-memory catalog with file path, MIME type, alt text, and dimensions. Filters out plugin directories (backup, ninja-popups, elementor, wpallimport, etc.).

### Phase 02 — Media Upload to S3

Uploads inventoried images to S3 with configurable concurrency. Deduplicates by SHA-256 hash. Before upload, supported raster images (jpeg/png/webp/avif/tiff) are optimized: EXIF orientation baked in, downscaled to fit 1920×1920, jpeg/png converted to webp, and webp/avif/tiff re-compressed at quality 80. Strapi-style responsive variants (`thumbnail`/`small`/`medium`/`large`) are generated and uploaded alongside the original, and recorded in the `files.formats` JSON column. For webp originals, AVIF "twin" variants (`original_avif`/`small_avif`/`medium_avif`/`large_avif`, quality 60, effort 3) are also encoded — from the pre-optimization source bytes for best quality — and merged into `formats`. gif/svg/other formats pass through untouched (`formats` stays NULL). Creates corresponding records in the Strapi `files` table with CloudFront URLs, dimensions, and provider metadata. See [Media / S3 Pipeline](#media--s3-pipeline) for details.

### Phase 03 — Taxonomies

Migrates WordPress category terms into **four** Strapi collections — `stores`, `brands`, `categories`, `banks` — based on the ACF `choose_type` termmeta field (defaults to "Store"). Also migrates FAQ items and SEO components for each entity, and links logo/icon media. Images embedded in term descriptions are rewritten through the content-media pipeline (see below).

### Phase 05 — Unique Coupon Pools

Migrates `wp_uc_coupons` rows into `unique_coupon_pools`, including computed `total_codes` and `used_codes` counts. Skipped if the source table doesn't exist.

### Phase 06 — Unique Codes

Migrates `wp_uc_codes` into `unique_codes` in batches (default 5,000). Links each code to its pool via the `unique_codes_pool_lnk` table. Handles PostgreSQL parameter limits by sub-batching link inserts.

### Phase 07 — Coupons

Migrates published WordPress posts (where `is_deal` is not `'yes'`) into the `coupons` table. For each coupon:

- Strips WordPress shortcodes from content
- Resolves `coupon_type` ("static" or "unique") from ACF meta
- Wires taxonomy relationships (store, brand, category, bank) via link tables, respecting Yoast primary term
- Links featured image, unique coupon pool, and SEO component
- Rewrites content-embedded images (see **Content-embedded images** below)

#### Content-embedded images

Rich-text HTML (`coupons.content`, `deals.content`, taxonomy `description`) can reference images directly via `<img src>` / `srcset` / lightbox `<a href>` URLs pointing at `wp-content/uploads/`. `utils/content-media.ts` rewrites every such reference:

1. The URL is normalized — query strings dropped, percent-encoding decoded, WP size suffixes (`-300x200`) and `-scaled` variants collapsed to the original file.
2. The path is resolved to an attachment ID via a `_wp_attached_file` reverse index and uploaded on demand through the same optimize/S3 pipeline as Phase 02 (deduplicated by content hash and in-flight path).
3. Files present in the uploads dir but missing a WP attachment row are uploaded straight from disk.
4. `<img>` tags are rebuilt with the new optimized URL plus a responsive `srcset`/`sizes` built from the generated Strapi formats; other uploads URLs are swapped in place.
5. Referenced files are linked in `files_related_mph` so Phase 11 treats them as used; unresolved URLs are left untouched and listed in the end-of-run stats. Phase 10 reports any rows still containing `wp-content/uploads` references.

### Phase 08 — Deals

Migrates deal posts (`is_deal='yes'`) into the `deals` table. Same relationship wiring as coupons, plus deal-specific fields: `mrp`, `sale_price`, `discount`, and `dealImage`. The `deal_store` meta is merged into the `stores` relation (deduplicated against taxonomy-linked stores).

### Phase 09 — SEO Backfill

Scans all six entity tables for rows missing an SEO component. Attempts to fill from `wp_yoast_indexable` data, resolving Yoast template variables.

### Phase 10 — Verification

Compares record counts between source and destination, checks relationship integrity, validates slug uniqueness, reports SEO coverage percentages, and runs sample spot checks. Never checkpointed — always runs. Failures are logged but non-fatal.

### Phase 11 — Copy Used Media

Copies only the media files actually referenced by entities (via `files_related_mph`) into Strapi's `public/uploads` directory (local-provider files only).

### Phase 12 — Offer Backfill

Backfills the `deal.primaryStore` manyToOne relation from WordPress data:

- The `deal.primaryStore` relation is resolved from the ACF `deal_store` postmeta key (a store term ID, plain or PHP-serialized). Links are written to the Strapi link table (detected at runtime via `information_schema`, expected name `deals_primary_store_lnk`) with delete-then-insert semantics so re-runs never leave stale rows.

Only posts present in the persisted ID maps (i.e., actually migrated) are touched. If the link table doesn't exist yet (Strapi schema not migrated), the phase logs a warning and skips gracefully.

### Phase 13 — Site Content

Seeds the four Strapi single types the frontend needs:

- `global` — header/footer codes from WP ACF option keys (`options_header_code`, `options_footer_code`).
- `homepage` — created as a **single published row** (draftAndPublish is disabled on all four singles — homepage, menu, footer, global — they are publish-only), with the full component tree built once. Also seeds `title: "Homepage"` for the admin entry header. Curated sections: hero banners from the `options_slider_features` ACF repeater; hero products and Top Deals from migrated Deal entities; CG Exclusive, Fresh Drops, Explore Offers, and Offers By Brand from Coupon entities; Popular Stores from `options_featured_stores` (fallback: top stores by published-coupon count); bank offers ranked by published-coupon count; plus How It Works and FAQ copy mirrored from the frontend. Per-section item counts live in `src/utils/homepage-limits.ts` (each holds a +4 buffer over what the site renders; a parity test pins them to the component schema `max` values).
- `menu` — topStores relation (same curated store list), one category section per explore category with its top stores, and the fixed extra nav items.
- `footer` — link sections, social links, countries, and partner card mirrored from the frontend `footer-data.ts`; Popular Stores labels are resolved to real store relations where a matching store name exists.

All component and relation link table names are verified against `information_schema` before writing; anything missing (schema not migrated yet) is skipped with a clear warning. Each single type is skipped entirely if its table already has a row, so re-runs are safe.

### Phase 13a — Homepage Coupon Offer Sections

Backfills existing homepages created before the Coupon-backed `exploreOffers` and `offersByBrand` components existed. It preserves the legacy section/category/brand criteria, selects real Coupons whose migration `contentStatus` is `published`, clones safe View All copy, and writes the new component trees transactionally. It never converts a Deal ID into a Coupon ID and is idempotent: populated new sections are skipped. Concurrent runs serialize on the homepage row. Missing Strapi component or relation infrastructure fails the phase so it is not checkpointed; apply the Strapi schemas first and rerun. The legacy Deal-backed fields remain available for one frontend compatibility release.

Run only this compatibility phase after deploying the new Strapi component schemas:

```bash
npm run migrate -- --phase 13a-homepage-offer-sections
```

### Phase 14 — Media Optimize (backfill)

Runs two passes over already-migrated S3 images.

**Pass 1 — full optimize backfill.** Candidates are `files` rows with `provider='aws-s3'`, `formats IS NULL`, and an optimizable MIME type (jpeg/png/webp/avif/tiff). For each candidate (5 in parallel):

1. **Source bytes** — resolved from the local `WP_UPLOADS_DIR` tree via a `sha256(file)[0:16] → path` map (cached in `.checkpoints/media-hash-map.json` keyed by mtime + size so re-runs don't rehash), falling back to downloading the current S3 object.
2. **Optimize** — same pipeline as Phase 02: orientation baked, max 1920px, jpeg/png → webp, quality 80. AVIF twins are encoded from the raw source bytes for webp results.
3. **Upload** — the optimized original (new `.webp` key when converted) plus all responsive variants (including AVIF twins).
4. **Update** — a single `UPDATE files SET formats, ext, mime, url, width, height, size, provider_metadata, updated_at` as the **last** step, so a crash leaves the row eligible for the next run (row-level resume via the `formats IS NULL` predicate).
5. **Cleanup** — the superseded S3 object is deleted when the key changed (jpeg/png → webp), unless `--keep-originals` is passed:

```bash
npm run migrate -- --phase 14-media-optimize --keep-originals
```

**Pass 2 — add-AVIF-only backfill.** Candidates are rows that already have `formats` but no `original_avif` key (`formats::jsonb ? 'original_avif'` is false) with MIME webp/jpeg/png. For each row, the source is resolved the same way (local hash map, then S3 object via `provider_metadata.key`), true dimensions are read via `sharp` metadata (falling back to the row's stored width/height), AVIF twins (`original_avif`/`small_avif`/`medium_avif`/`large_avif`) are encoded and uploaded next to the existing variants, and the new keys are merged into the existing JSON with a single `UPDATE files SET formats = formats || $new`. Idempotent via the missing-`original_avif` predicate; `--keep-originals` is a no-op for this pass.

Fails fast with a clear error if the `files` table is empty (run a full migration first).

---

## Data Mapping

### Taxonomies (Phase 03)

WordPress stores all taxonomy terms in `wp_terms` with `taxonomy='category'`. The ACF `choose_type` termmeta determines which Strapi collection each term maps to:

| `choose_type` value | Strapi table |
|---------------------|-------------|
| `Store` (default)   | `stores`    |
| `Brand`             | `brands`    |
| `Category`          | `categories`|
| `Bank`              | `banks`     |

**Field mapping:**

| WordPress | Strapi | Notes |
|-----------|--------|-------|
| `name` | `name` | |
| `slug` | `slug` | Deduplicated per table (appends `-1`, `-2`, etc.) |
| `description` | `description` | |
| `store_short_description` (termmeta) | `short_description` | |
| `store_cat_image` (termmeta) | `logo` / `icon` | Media link via `files_related_morphs` |
| `store_image_alt` (termmeta) | `logo_alt` | Stores, brands, banks only |
| `enable_faq_schema` (termmeta) | `faq_enabled` | Boolean (`'1'` → true) |

### Posts: Coupons vs Deals (Phases 07–08)

All WordPress posts with `post_type='post'` and `post_status='publish'` are split:

- **Deal** — `is_deal` postmeta = `'yes'` → `deals` table
- **Coupon** — everything else → `coupons` table

**Common field mapping (both coupons and deals):**

| WordPress | Strapi | Notes |
|-----------|--------|-------|
| `post_title` | `title` | |
| `post_name` | `slug` | Deduplicated |
| `post_content` | `content` | Shortcodes stripped |
| `code` (postmeta) | `code` | Coupon code string |
| `link` (postmeta) | `affiliate_link` | |
| `popular_coupon` (postmeta) | `is_popular` | `'1'` → true |
| `unique_coupon` (postmeta) | `coupon_type` | `'1'`/`'true'` → `"unique"`, else `"static"` |
| `unique_coupon_name` (postmeta) | `uniqueCouponPool` relation | Resolved by pool name for unique coupons |
| Expiration meta* | `expires_at` | Unix timestamp or ISO date |
| `post_date` | `published_at` | |

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

Each coupon/deal can link to one store, one brand, one category, and one bank via link tables (`coupons_store_lnk`, `deals_brand_lnk`, etc.). The Yoast primary term is processed first. If multiple terms map to the same type, only the first is linked.

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

For each inventoried image:

1. **Hash** — SHA-256 of file contents, truncated to 16 characters
2. **S3 key** — `{S3_ROOT_PATH}/{hash}_{filename}{ext}`
3. **Dedup check** — skip if hash already exists in Strapi `files` table
4. **Upload** — PUT to S3 with `Cache-Control: public, max-age=31536000, immutable`
5. **Metadata** — extract width/height via `sharp`, compute file size in KB
6. **Register** — insert into Strapi `files` table:
   - `document_id`: CUID v2
   - `url`: `{S3_BASE_URL}/{s3Key}` (or AWS default URL)
   - `provider`: `"aws-s3"`
   - `provider_metadata`: JSON with S3 key
   - `hash`, `name`, `alternative_text`, `caption`, `width`, `height`, `ext`, `mime`, `size`
7. **ID map** — store `WP attachment_id → Strapi file_id` for later linking

If `S3_BUCKET` is empty, files are registered as local provider records with `/uploads/{fileName}` URLs.

### Media Linking

When a phase needs to attach media to an entity (e.g., store logo, coupon image), it:

1. Resolves the WP attachment ID or URL via `resolveMediaRef()` → Strapi `file_id`
2. Inserts a row into `files_related_morphs` with the entity type, entity ID, and field name

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

### Checkpointing

- Each phase writes a checkpoint file to `.checkpoints/{phase}.json` on completion
- On restart, completed phases are skipped automatically
- `--clean` deletes checkpoint files but **preserves ID map files**

### ID Map Persistence

Five maps are serialized to `.checkpoints/` as JSON:

| Map | Key | Value |
|-----|-----|-------|
| `termIdMap` | WP term_id | `{id, documentId, type, table}` |
| `postIdMap` | WP post_id | `{id, documentId, type, table}` |
| `mediaIdMap` | WP attachment_id | Strapi file_id |
| `poolIdMap` | WP pool_id | `{id, documentId, type, table}` |
| `poolNameMap` | WP pool name | `{id, documentId, type, table}` |

Maps are loaded at startup and saved after each phase, enabling later phases to reference IDs created by earlier ones.

### Database-Level Idempotency

- All main entity inserts use `ON CONFLICT (document_id) DO NOTHING`
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
