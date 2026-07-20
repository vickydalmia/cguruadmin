# Fresh Migration Runbook

Step-by-step guide for migrating WordPress → Strapi into an **empty** target
database (new environment, go-live, or a full re-do). For reference material —
what each phase does internally, data mapping, troubleshooting — see
[README.md](./README.md). For refreshing only the homepage on an already
migrated database, skip to [Maintenance scripts](#maintenance-scripts).

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
```

`PG_CONNECTION_STRING` in `.env.migration` **is the target selector** — every
script in this package (migration, reset, markdown fix) writes to whatever it
points at. Point it at the deployed database deliberately, and treat the file
as secret (it is gitignored; never paste its contents into chats or logs).

Key settings (full list in README § Setup & Configuration):

| Variable | Purpose |
|---|---|
| `PG_CONNECTION_STRING` + `PG_CA_CERT_PATH` | Target Strapi Postgres (TLS verified for remote DBs) |
| `WP_DB_*` | Source WordPress MySQL |
| `SSH_HOST` / `SSH_PRIVATE_KEY_PATH` / `SSH_HOST_FINGERPRINT` | Optional tunnel to the WP DB (fingerprint is required when tunneling) |
| `WP_UPLOADS_DIR` | Local path to `wp-content/uploads/` |
| `S3_*` | Media destination |

## 3. Run the migration

```bash
yarn migrate
```

One command runs every phase in order. Each phase checkpoints on completion,
so if anything fails you fix the cause and re-run `yarn migrate` — it resumes
where it stopped. To re-run one phase against existing data, use
`yarn migrate:phase <name>`.

### What `--clean` destroys

> 🛑 **`yarn migrate:fresh` is `tsx src/index.ts --clean` — the most
> destructive command in this repo. It is not a checkpoint reset.** Against
> whatever `PG_CONNECTION_STRING` and `S3_BUCKET` point at, and with no
> confirmation prompt, it deletes:

| # | What | Detail |
|---|---|---|
| 1 | Checkpoint files | `.checkpoints/*.json` — every phase becomes eligible again |
| 2 | **All six ID map files** | `termIdMap` / `postIdMap` / `mediaIdMap` / `poolIdMap` / `poolNameMap` / `userIdMap` `.json` are unlinked from disk (`clearAllMaps()`). Relationship data from earlier phases is **not** retained |
| 3 | Every migrated table | `TRUNCATE … RESTART IDENTITY CASCADE` over the explicit list in [`src/index.ts`](./src/index.ts) — coupons, deals, stores, brands, categories, banks, unique pools/codes, `files`, all link tables, all `components_*` tables — **plus** every `*_cmps` / `*_lnk` table auto-discovered from `information_schema` under the owned-prefix allowlist |
| 4 | **The four singles** | `homepages`, `menus`, `footers`, `globals` and their component join tables are in that truncate list. A "fresh" run therefore wipes the curated homepage, menu, footer and global settings, and phase 13 reseeds them from WordPress |
| 5 | Migration-created admin users | `admin_users` rows whose `document_id` starts with `wp_` (phase 06a's accounts) and their role links. Accounts created by hand in the admin — including the super admin — survive |
| 6 | **The whole S3 prefix** | `clearS3Bucket()` deletes every object under `S3_ROOT_PATH/` in `S3_BUCKET`. It refuses to run when `S3_ROOT_PATH` is empty (that would empty the entire bucket) and is skipped when S3 is not configured |

> Only the admin-user step and the S3 prefix guard are scoped. Nothing else is
> reversible without a database backup. On a live catalog, take one first.

### Phase order

| Phase | What it does |
|---|---|
| `00-preflight` | Validates both DBs and required tables — fails fast, writes nothing |
| `01-media-inventory` → `02-media-upload` | Catalogs WP media and uploads to S3 |
| `03-taxonomies` | Stores, brands, categories, banks |
| `05-pools` → `06-codes` → `06a-users` | Unique-coupon pools/codes, authors |
| `07-coupons` → `08-deals` | The offers themselves (content sanitized through the shared `cleanHtml` allowlist on the way in) |
| `09-seo-backfill` | Yoast SEO fields |
| `10-verify` | Count/spot-check verification report |
| `11-copy-used-media` → `12-offer-backfill` | Media wiring and offer relation backfill |
| `13-site-content` | Global, **homepage**, menu, footer singles |
| `13a-homepage-offer-sections` | Backfill for **pre-existing** homepages only — on a fresh run phase 13 already seeds everything and this is a no-op |
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

## 4. Verify

- [ ] Phase `10-verify` output shows no missing counts.
- [ ] `GET <strapi-url>/api/homepage-full` — sections filled to the seed
      counts: topOffers 8, popularStores 1+24, topDeals 10, cgExclusive 8,
      exploreOffers ≤10/tab, newlyAdded 8, offersByBrand 7, bankOffers 12.
- [ ] `GET <strapi-url>/api/search?q=<known store>` returns grouped results.
- [ ] Admin: log in, open Homepage, **save once** — proves component caps and
      image validation pass on the seeded data.
- [ ] Spot-check a store page and a coupon image URL (CDN base correct).

## 5. After migration

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
| `yarn backfill:offer-fields` | Fill `badge` / `offerText` / `cashbackText` / `bankOfferText` on offers migrated before those fields existed |
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

### Backfill the newer offer fields

For databases migrated **before** `badge` / `offerText` / `cashbackText` /
`bankOfferText` existed. It is **fill-only** — every field is written only
where it is currently NULL, so editor edits and re-runs are never clobbered —
and it uses the same extractor as phases 07/08, so backfilled values match a
fresh run. Deploy the new schema and **boot Strapi once first** so it creates
the nullable columns; the script only fills them, and warns-and-skips per
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
