# CouponzGuru CMS (Strapi 5)

The backend for CouponzGuru: a Strapi 5 application that is simultaneously the
editorial CMS, the public read API the website consumes, and the producer of
durable persistent-ISR invalidation events.

It does three jobs:

1. **CMS** — editors manage stores, brands, categories, banks, coupons, deals
   and the curated homepage/menu/footer through a customized admin panel.
2. **Public API** — a hand-written read surface (`/api/search`,
   `/api/directories/:kind`, `/api/homepage-full`, offer listings, ratings,
   redeem) consumed by the ISR gateway and the Astro frontend. Core Strapi
   `find`/`findOne` routes for offers stay **disabled**; see
   [docs/public-api.md](./docs/public-api.md).
3. **ISR producer** — content changes commit a transactional outbox event in
   PostgreSQL; the dispatcher delivers it to the gateway for targeted
   regeneration.

Media lives in S3 behind a CDN, with responsive variants (and AVIF twins)
generated at upload time from the shared knobs in
[`src/constants/image.ts`](./src/constants/image.ts).

## Content model

Draft & publish is **disabled on every type** — an entry is live as soon as it
is saved. Offer visibility is instead driven by the `contentStatus` /
`scheduledAt` / `expiresAt` fields, so "published" is a data state, not a Strapi
lifecycle state.

| Type | Kind | What it is |
|---|---|---|
| **Store** | collection | A merchant. Owns `slug` (may contain nested path segments), logo, `ratingAverage`/`ratingCount` from the anonymous rating system, curated Top Picks, FAQs and SEO |
| **Brand** | collection | A brand entity page, same shape as Store |
| **Category** | collection | A category entity page; carries `icon` rather than `logo` |
| **Bank** | collection | A bank entity page (bank-offer pages) |
| **Coupon** | collection | A code or no-code offer: `title`, `code`, `couponType` (`static` \| `unique`), affiliate link, badge/cashback text, and relations to store/brand/category/bank |
| **Deal** | collection | A product deal: adds `salePrice`, `mrp`, `discount`, `dealImage` and a `primaryStore`. A Deal only counts as a product deal when it has a sale price |
| **Unique Coupon Pool** | collection | A named pool of single-use codes backing `couponType: unique` |
| **Unique Code** | collection | One code in a pool, marked used on redemption |
| **Homepage** | single | The curated home page as a deep component tree (hero, top offers, popular stores, explore tabs, bank offers, FAQ …) |
| **Menu** | single | Header navigation: top stores plus per-category sections |
| **Footer** | single | Footer link sections, socials, countries, partner card |
| **Global Settings** | single | Site-wide header/footer code injection |
| **Deal of the Day Page** | single | The curated Deal of the Day page |

Schemas live at `src/api/*/content-types/*/schema.json`; reusable components at
[`src/components/`](./src/components).

## Local development

Requires Node 20–24 and a PostgreSQL database. Copy `.env.example` to `.env`
and fill it in first.

```bash
yarn install
yarn develop          # start with autoReload + admin rebuild (dev)
yarn start            # start without autoReload (prod-like)
yarn build            # build the admin panel
yarn test             # vitest run
yarn test:watch
yarn types:generate   # regenerate Strapi TS types after schema changes
yarn console          # REPL against the app
```

`yarn develop` is the normal loop; the admin panel is customized in
[`src/admin/`](./src/admin), so admin-side changes need a rebuild to appear.

## Deployment

**Do not run `yarn strapi deploy`** — that targets Strapi Cloud and is not how
this project ships. The real path is:

> **GitHub Release → GitHub Actions build → GHCR image → `./deploy.sh` on the
> droplet**

GitHub Actions only builds and pushes the image; deployment is a deliberate
manual step on the server, and rollback is `./deploy.sh <previous-tag>` against
an immutable tag. The full procedure — droplet provisioning, environment
reference, nginx, S3, health checks, rollback and troubleshooting — is in
**[docs/strapi-production-deployment.md](./docs/strapi-production-deployment.md)**.

One deploy-order rule worth knowing before you ship: rolling Strapi back across
the search "insights" contract boundary requires rolling the ISR gateway back
in the same window.

## Migrating from WordPress

The `migration/` directory is a **self-contained package** (its own
`package.json`, its own `.env.migration`) that moves the legacy WordPress + ACF
site into this Strapi instance — taxonomies, posts, media to S3, unique coupon
codes, SEO.

- [migration/FRESH-MIGRATION.md](./migration/FRESH-MIGRATION.md) — the operator
  runbook: what to type, in order, plus the maintenance/repair script catalog.
- [migration/README.md](./migration/README.md) — the reference: what each phase
  does internally, data mapping, the media pipeline, idempotency.

⚠️ `yarn migrate:fresh` (`--clean`) is destructive: it truncates every migrated
table **including the homepage/menu/footer/global singles**, deletes all ID
maps, and empties the S3 prefix. Read
[What `--clean` destroys](./migration/FRESH-MIGRATION.md#what---clean-destroys)
before running it against anything you care about.

## Documentation

| Document | What it covers |
|---|---|
| [docs/public-api.md](./docs/public-api.md) | The public read contract: search params/groups/envelope, directory, page aggregates, offer listings, ratings, redeem and unique-coupon endpoints, with each route's auth, rate limit and cache |
| [docs/search-operations.md](./docs/search-operations.md) | Operator reference for search: execution modes, the 11 expected trigram indexes, `/api/search/status`, and automatic migration/bootstrap reconciliation |
| [docs/related-stores-api.md](./docs/related-stores-api.md) | The four `/related-stores` endpoints: ranking, category profile, and the high-rated fallback |
| [docs/strapi-production-deployment.md](./docs/strapi-production-deployment.md) | End-to-end production deployment, environment reference, nginx, rollback, troubleshooting |
| [docs/admin-taxonomy-panel.md](./docs/admin-taxonomy-panel.md) | How the admin bundle is customized: the Taxonomies panel and the custom field components |
| [docs/wordpress-migration.md](./docs/wordpress-migration.md) | Deep walkthrough of the migration pipeline's internals |
| [docs/qa-fixes-2026-07.md](./docs/qa-fixes-2026-07.md) | Point-in-time record of the July 2026 backend QA batch, including manual operator steps |

Agent-facing Strapi v5 reference material lives in `.agents/skills/` and is not
part of the human documentation set.
