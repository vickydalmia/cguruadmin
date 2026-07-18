# WordPress → Strapi v5 Migration — Line-by-Line Reference

A deep technical walkthrough of the migration pipeline at `migration/`. Companion to `migration/README.md` (which covers *how to run*); this document covers *how it works*.

Scope: every TypeScript source file under `migration/src/`, every SQL query verbatim, every relationship wire, how media is filtered and resolved, connection lifecycle, and the `--clean` contract.

> **Line-number drift warning.** The exact `(lines N–M)` pins in this document
> predate the media-optimize work (the phase-02 optimize/variant pipeline,
> phases 12–15, and the expanded `--clean` truncate list) — treat them as
> approximate unless a section says otherwise. `migration/README.md` is the
> maintained phase reference; phases 12–15 are covered compactly in §6n below.

---

## 1. Overview

### What it does

The migration ingests a large WordPress 5.x site (coupons + deals plus supporting taxonomies, media, SEO, and unique coupon codes) and writes the equivalent Strapi v5 content into a PostgreSQL database, with media living in S3 (or a local filesystem fallback).

Sources:
- **MySQL** — WordPress core tables (`wp_posts`, `wp_postmeta`, `wp_terms`, `wp_term_taxonomy`, `wp_term_relationships`, `wp_termmeta`, `wp_users`, `wp_usermeta`), plus optional `wp_uc_coupons`, `wp_uc_codes`, and `wp_yoast_indexable` / `wp_yoast_primary_term` when Yoast is installed.
- **Filesystem** — `wp-content/uploads/` on disk for the actual image bytes.

Targets:
- **PostgreSQL** — Strapi v5's schema. Entity tables (`stores`, `brands`, `categories`, `banks`, `coupons`, `deals`, `unique_coupon_pools`, `unique_codes`, `files`, `admin_users`), plus Strapi v5's conventional link tables (`{owner}_{field}_lnk`), component join tables (`{owner}_cmps`), component data (`components_shared_seos`, `components_shared_faq_items`), and the polymorphic media join (`files_related_mph`).
- **S3 / local** — one record per unique image, deduped by SHA-256.

### Shape

```
config ─► connections ─► Phase loop ─► checkpoints ─► verification
           (MySQL + PG)    (00 → 15)     (per phase)     (non-fatal)
                             │
                             ├── Media inventoried (01)
                             ├── Media uploads happen on-demand (02)
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
- **Deterministic `document_id`** derived from WP primary keys → Strapi `ON CONFLICT ("document_id") DO NOTHING` makes every insert idempotent.
- **Per-phase checkpoint files** (`.checkpoints/<phase>.json`) skip completed phases on rerun.
- **Persisted id maps** (`.checkpoints/*.json`) let later phases run standalone without re-doing their prereqs.

### File map

| Path | Role |
|---|---|
| `migration/src/index.ts` | Orchestrator: phase list, `--clean` + `--phase` flags, checkpoint loop |
| `migration/src/config.ts` | Env → typed config; nothing else |
| `migration/src/db/wp-client.ts` | MySQL pool + optional SSH tunnel |
| `migration/src/db/pg-client.ts` | Postgres pool + optional CA-cert SSL |
| `migration/src/utils/id-maps.ts` | In-memory maps persisted to `.checkpoints/*.json` |
| `migration/src/utils/checkpoint.ts` | Phase-completion bookkeeping |
| `migration/src/utils/strapi-insert.ts` | `generateDocumentId`, `batchInsert`, `insertLink`, `insertComponent`, `linkMedia` |
| `migration/src/utils/sanitize.ts` | `clean`, `cleanSlug`, `cleanCode` |
| `migration/src/utils/wp-dates.ts` | UTC vs local date normalization |
| `migration/src/utils/content-status.ts` | published / scheduled / expired classifier |
| `migration/src/utils/admin-auth.ts` | bcrypt random password, reset token, name splitter |
| `migration/src/utils/media-resolver.ts` | `resolveMediaRef` + on-demand upload hook |
| `migration/src/utils/acf-repeater.ts` | `parseFaqRepeater` for ACF's flat-key FAQ format |
| `migration/src/utils/yoast-vars.ts` | Yoast `%%title%%` → string templating |
| `migration/src/utils/slug-dedup.ts` | Per-table slug uniqueness tracker |
| `migration/src/utils/logger.ts` | Winston: colorized console + two log files |
| `migration/src/phases/00-preflight.ts` | Connection probes, schema sanity checks, unique indexes |
| `migration/src/phases/01-media-inventory.ts` | WP attachment scan + plugin-dir blacklist |
| `migration/src/phases/02-media-upload.ts` | On-demand S3/local upload + hash dedup |
| `migration/src/phases/03-taxonomies.ts` | Stores / brands / categories / banks + FAQ + SEO |
| `migration/src/phases/05-pools.ts` | `wp_uc_coupons` → `unique_coupon_pools` |
| `migration/src/phases/06-codes.ts` | `wp_uc_codes` → `unique_codes` + pool links |
| `migration/src/phases/06a-users.ts` | WP authors → `admin_users` + creator backfill |
| `migration/src/phases/07-coupons.ts` | Non-deal posts → `coupons` + all relations |
| `migration/src/phases/08-deals.ts` | `is_deal='yes'` posts → `deals` + relations (with `deal_store` merge) |
| `migration/src/phases/09-seo-backfill.ts` | Fill SEO components from `wp_yoast_indexable` |
| `migration/src/phases/10-verify.ts` | Count + integrity + spot checks |
| `migration/src/phases/11-copy-used-media.ts` | Copy locally-provisioned files to Strapi's `public/uploads` |
| `migration/src/phases/12-offer-backfill.ts` | `deal.primaryStore` relation backfill from `deal_store` meta |
| `migration/src/phases/13-site-content.ts` | Seed global / homepage / menu / footer single types |
| `migration/src/phases/13a-homepage-offer-sections.ts` | Coupon-backed homepage section backfill (pre-existing homepages) |
| `migration/src/phases/14-media-optimize.ts` | Optimize + AVIF-twin backfill for already-migrated media |
| `migration/src/phases/15-media-formats-backfill.ts` | Variant-matrix gap backfill (xsmall / thumbnail / AVIF twins) |
| `migration/src/utils/image-optimizer.ts` | Optimize originals + generate the variant matrix / AVIF twins (knobs re-exported from `src/constants/image.ts`) |
| `migration/src/utils/content-media.ts` | Rewrite content-embedded `wp-content/uploads` images through the upload pipeline |

---

## 2. Entry & Orchestration — `src/index.ts`

### The `Phase` contract (lines 25–29)

```ts
interface Phase {
  name: string;
  fn: () => Promise<void>;
  skipCheckpoint?: boolean;
}
```

`skipCheckpoint` is set on phases we want to run every time (connection probes, verification) regardless of whether a prior run already completed them.

### The phase array

```ts
const phases: Phase[] = [
  { name: "00-preflight",              fn: runPreflight,             skipCheckpoint: true },
  { name: "01-media-inventory",        fn: runMediaInventory },
  { name: "02-media-upload",           fn: runMediaUpload },
  { name: "03-taxonomies",             fn: runTaxonomies },
  { name: "05-pools",                  fn: runPools },
  { name: "06-codes",                  fn: runCodes },
  { name: "06a-users",                 fn: runUsers },
  { name: "07-coupons",                fn: runCoupons },
  { name: "08-deals",                  fn: runDeals },
  { name: "09-seo-backfill",           fn: runSeoBackfill },
  { name: "10-verify",                 fn: runVerification,          skipCheckpoint: true },
  { name: "11-copy-used-media",        fn: runCopyUsedMedia },
  { name: "12-offer-backfill",         fn: runOfferBackfill },
  { name: "13-site-content",           fn: runSiteContent },
  { name: "13a-homepage-offer-sections", fn: runHomepageOfferBackfill },
  { name: "14-media-optimize",         fn: runMediaOptimize },
  { name: "15-media-formats-backfill", fn: runMediaFormatsBackfill,  skipCheckpoint: true },
];
```

Order matters: 01 must run before 03–08 so inventoried attachments are resolvable; 03–06 must run before 07–08 so taxonomies/pools are in the id maps; 06a must run before 07–08 so author ids are available for `created_by_id`. The trailing backfills (12–15) run against already-migrated rows, so they come after the entity phases. `15-media-formats-backfill` carries `skipCheckpoint: true` (its candidate SQL is the idempotency guard, so it stays re-runnable — a `--dry-run`/`--limit` pilot must never mark it complete). See §6n for phases 12–15.

Note that **Phase 02 is special** — its `runMediaUpload` only preloads the hash cache and logs counts. Actual S3 uploads happen *on demand* later via `uploadMediaOnDemand`, called from `resolveMediaRef` in `utils/media-resolver.ts`.

### CLI flags

- `--clean` — wipe migration state before running (see §2a).
- `--phase <name>` — run exactly one phase, skipping everything else. No completeness check on the target phase. Useful for re-running after a code change.

### 2a. `--clean` flow (lines 56–108)

This is the destructive path — not called by default. When invoked:

1. **Clear local state**
   - `clearCheckpoints()` removes `.checkpoints/*.json` files that track phase completion (but leaves the id-map files — see note below).
   - `clearAllMaps()` empties the in-memory maps **and** deletes the `*Map.json` files from disk.

2. **Truncate Strapi data in FK-safe order** (lines 62–88)
   ```ts
   const tablesToTruncate = [
     // Link/join tables first
     "coupons_stores_lnk", "coupons_brands_lnk", "coupons_categories_lnk", "coupons_banks_lnk",
     "coupons_unique_coupon_pool_lnk",
     "deals_stores_lnk", "deals_brands_lnk", "deals_categories_lnk", "deals_banks_lnk",
     "unique_codes_pool_lnk",
     "files_related_mph",
     // Component join tables
     "stores_cmps", "brands_cmps", "categories_cmps", "banks_cmps",
     // Component data tables
     "components_shared_seos", "components_shared_faq_items",
     // Entity tables
     "coupons", "deals",
     "unique_codes", "unique_coupon_pools",
     "stores", "brands", "categories", "banks",
     // Media (only migration-created records)
     "files",
   ];
   for (const table of tablesToTruncate) {
     try {
       await pool.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
     } catch (err: any) {
       logger.warn(`Could not truncate ${table}: ${err.message}`);
     }
   }
   ```
   `RESTART IDENTITY` resets the `id` sequences so re-inserts start at 1. `CASCADE` would drop FK-dependent rows if any were missed — but we still order the list link-tables-first so FKs don't fire.

3. **Admin-user cleanup** (lines 93–101)
   ```sql
   DELETE FROM "admin_users_roles_lnk"
   WHERE user_id IN (SELECT id FROM "admin_users" WHERE document_id LIKE 'wp\_%' ESCAPE '\');

   DELETE FROM "admin_users" WHERE document_id LIKE 'wp\_%' ESCAPE '\';
   ```
   The `ESCAPE '\'` clause makes `\_` a literal underscore (not the LIKE wildcard), so this only matches migration-created admins. The super admin — created manually via Strapi's admin console — doesn't carry the `wp_` prefix and survives.

4. **S3 cleanup** — `clearS3Bucket()` lists and deletes every object under `config.s3.rootPath` (see §6c).

Note: this *does not* delete admin users from SSO providers or anything outside these tables.

### 2b. Phase loop (lines 117–138)

```ts
for (const phase of phases) {
  if (specificPhase && phase.name !== specificPhase) continue;

  if (!specificPhase && !phase.skipCheckpoint && isPhaseComplete(phase.name)) {
    logger.info(`Skipping ${phase.name} (already complete)`);
    continue;
  }

  const phaseStart = Date.now();
  await phase.fn();
  const phaseDuration = ((Date.now() - phaseStart) / 1000).toFixed(1);
  logger.info(`${phase.name} completed in ${phaseDuration}s`);

  if (!phase.skipCheckpoint) {
    markPhaseComplete(phase.name);
    saveMaps();
  }
}
```

- `specificPhase` (from `--phase`) forces a single phase regardless of checkpoint.
- Otherwise each non-`skipCheckpoint` phase is gated on `isPhaseComplete()`.
- After each non-`skipCheckpoint` phase, we write the checkpoint marker **and** persist the id maps so a later `--phase 08-deals` run can find its prereqs.

### 2c. Error path (lines 145–153)

```ts
} catch (err: any) {
  logger.error(`Migration failed: ${err.message}`);
  logger.error(err.stack);
  saveMaps(); // Save progress even on failure
  process.exit(1);
} finally {
  await closeWp();
  await closePg();
}
```

On throw: log → persist whatever id-map progress we have → exit 1. `finally` always closes both DB pools (and for MySQL that also tears down the SSH tunnel and server).

---

## 3. Config — `src/config.ts`

Shape only; values come from `.env.migration`. Structure:

```ts
export const config = {
  ssh: {
    host, port, user,
    privateKeyPath: optional("SSH_PRIVATE_KEY_PATH").replace(/^~/, os.homedir()),
  },
  wp: { host, port, user, password, database: required("WP_DB_NAME") },
  pg: {
    connectionString: required("PG_CONNECTION_STRING"),
    caCertPath: optional("PG_CA_CERT_PATH").replace(/^~/, os.homedir()),
    rejectUnauthorized: optional("PG_SSL_REJECT_UNAUTHORIZED", "true") === "true",
  },
  s3: { bucket, region, accessKeyId, secretAccessKey, baseUrl, rootPath, endpoint },
  wpUploadsDir: path.resolve(__dirname, "..", optional("WP_UPLOADS_DIR", "../wordpress/wp-content/uploads")),
  batchSize: parseInt(optional("BATCH_SIZE", "5000")),
  mediaConcurrency: parseInt(optional("MEDIA_CONCURRENCY", "10")),
  logLevel: optional("LOG_LEVEL", "info"),
};
```

Highlights:
- Only `WP_DB_NAME` and `PG_CONNECTION_STRING` are required. Everything else has a sensible default or can be omitted.
- `~` expansion is applied on both `SSH_PRIVATE_KEY_PATH` and `PG_CA_CERT_PATH` so developers can write `~/.ssh/id_rsa` or `~/certs/pg.pem` without worrying about absolute paths.
- `wpUploadsDir` is resolved relative to `migration/` (the package dir), not `process.cwd()`.

---

## 4. Database Connections

### 4a. WordPress MySQL — `src/db/wp-client.ts`

Three module-level singletons (lines 8–11):

```ts
let pool: mysql.Pool | null = null;
let sshClient: SSHClient | null = null;
let localServer: net.Server | null = null;
let tunnelPort: number | null = null;
```

#### SSH tunnel (lines 13–70)

When `config.ssh.host` is set, the first call to `getWpPool()` creates a tunnel before opening the MySQL pool:

```ts
ssh.on("ready", () => {
  logger.info(`SSH tunnel connected to ${config.ssh.host}`);

  const server = net.createServer((sock) => {
    ssh.forwardOut(
      "127.0.0.1",
      0,
      config.wp.host,
      config.wp.port,
      (err, stream) => {
        if (err) { sock.destroy(); return; }
        sock.pipe(stream).pipe(sock);
      }
    );
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address() as net.AddressInfo;
    tunnelPort = addr.port;
    resolve(tunnelPort);
  });
});
```

- `ssh.forwardOut(…)` opens a channel from the SSH server to `config.wp.host:config.wp.port` **as seen by the SSH host** (so the MySQL host can be `localhost` from the bastion's POV).
- `server.listen(0, "127.0.0.1")` asks the OS for any free port. The local port is returned and passed to `mysql.createPool` as `host: 127.0.0.1, port: tunnelPort`.
- Every MySQL connection the pool opens gets `ssh.forwardOut` pipeed through the SSH channel transparently.

#### Auth precedence (lines 62–66)

```ts
if (process.env.SSH_AUTH_SOCK) {
  connectOpts.agent = process.env.SSH_AUTH_SOCK;
} else if (config.ssh.privateKeyPath && existsSync(config.ssh.privateKeyPath)) {
  connectOpts.privateKey = readFileSync(config.ssh.privateKeyPath);
}
```

ssh-agent (via `SSH_AUTH_SOCK`) wins — lets developers run the migration with their usual agent-backed keys. Falls back to a private key file on disk.

#### MySQL pool (lines 82–92)

```ts
pool = mysql.createPool({
  host, port, user: config.wp.user, password: config.wp.password, database: config.wp.database,
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
  dateStrings: true,
});
```

- `charset: "utf8mb4"` — preserves 4-byte UTF-8 (emoji, etc.) coming out of WP.
- `dateStrings: true` — this is why every phase handles `post_date` as a *string*, not a `Date`. mysql2's default behavior would coerce datetimes to local-timezone `Date` objects, which would silently drift the values. By keeping them as strings, the date normalization in `utils/wp-dates.ts` can interpret them deterministically.

#### The helper (lines 97–104)

```ts
export async function wpQuery<T = any>(sql: string, params?: any[]): Promise<T[]> {
  const p = await getWpPool();
  const [rows] = await p.execute(sql, params);
  return rows as T[];
}
```

Uses `execute()` — prepared statement with parameter binding, not string interpolation. Every `?` placeholder in the callers below is safely parameterized.

### 4b. Strapi Postgres — `src/db/pg-client.ts`

#### SSL builder (lines 10–20)

```ts
function buildSslConfig(): pg.PoolConfig["ssl"] {
  const { caCertPath, rejectUnauthorized } = config.pg;
  if (!caCertPath) return false;
  const resolved = path.isAbsolute(caCertPath)
    ? caCertPath
    : path.resolve(process.cwd(), caCertPath);
  if (!existsSync(resolved)) {
    throw new Error(`PG CA cert not found at ${resolved}`);
  }
  return { ca: readFileSync(resolved, "utf8"), rejectUnauthorized };
}
```

- No `caCertPath` → `ssl: false` (plain connection — only suitable for local dev).
- Relative path → resolved against `process.cwd()`, not the module dir. (`.env.migration` carries a path like `./certs/pg.pem`.)
- Missing file throws synchronously — fail fast at pool creation.

#### Pool (lines 22–31)

```ts
export function getPgPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.pg.connectionString,
      ssl: buildSslConfig(),
      max: 10,
    });
  }
  return pool;
}
```

Lazy singleton. Helpers (lines 33–48): `pgQuery<T>` returns rows directly, `pgQueryOne<T>` returns the first row or `null`.

---

## 5. Shared Utilities — `src/utils/`

### 5a. `id-maps.ts` — the spine of the migration

Six `Map`s, each persisted as JSON under `migration/.checkpoints/`:

```ts
// wp_term_id -> Strapi entity info (stores/brands/categories/banks)
const termIdMap = new Map<number, StrapiEntityRef>();

// wp_post_id -> Strapi entity info (coupons/deals)
const postIdMap = new Map<number, StrapiEntityRef>();

// wp_attachment_id -> Strapi file id
const mediaIdMap = new Map<number, number>();

// wp_uc_coupons.id -> Strapi pool info
const poolIdMap = new Map<number, StrapiEntityRef>();

// pool name (raw or lowercased) -> Strapi pool info
const poolNameMap = new Map<string, StrapiEntityRef>();

// wp_users.ID -> Strapi admin_users.id
const userIdMap = new Map<number, number>();
```

`StrapiEntityRef` (lines 11–16):

```ts
export interface StrapiEntityRef {
  id: number;
  documentId: string;
  type: string; // 'api::store.store' etc.
  table: string; // PG table name
}
```

#### `ensureTermMapping` (lines 60–81)

The one map that can lazy-load from DB on a miss. Used by phases 07 and 08 (plus 06a's backfill) so they can run with `--phase` without needing phase 03 in the same process.

```ts
export async function ensureTermMapping(wpTermId: number): Promise<StrapiEntityRef | undefined> {
  const cached = termIdMap.get(wpTermId);
  if (cached) return cached;

  const pool = getPgPool();
  for (const { table, type } of TAXONOMY_TABLES) {
    const documentId = generateDocumentId(`term:${table}:${wpTermId}`);
    const result = await pool.query<{ id: number }>(
      `SELECT id FROM "${table}" WHERE "document_id" = $1 LIMIT 1`,
      [documentId]
    );
    const id = result.rows[0]?.id;
    if (id) {
      const ref: StrapiEntityRef = { id, documentId, type, table };
      termIdMap.set(wpTermId, ref);
      return ref;
    }
  }
  return undefined;
}
```

- Computes the deterministic `document_id` for each of the four taxonomy tables.
- Queries each table; the first hit wins.
- Caches into `termIdMap` so the next call is free.

#### Pool name normalization (lines 107–123)

```ts
export function setPoolNameMapping(poolName: string, ref: StrapiEntityRef): void {
  const rawKey = normalizePoolName(poolName, false);
  const normalizedKey = normalizePoolName(poolName, true);
  if (rawKey) poolNameMap.set(rawKey, ref);
  if (normalizedKey) poolNameMap.set(normalizedKey, ref);
}

export function getPoolMappingByName(poolName: string): StrapiEntityRef | undefined {
  const rawKey = normalizePoolName(poolName, false);
  if (rawKey) {
    const exact = poolNameMap.get(rawKey);
    if (exact) return exact;
  }
  const normalizedKey = normalizePoolName(poolName, true);
  return normalizedKey ? poolNameMap.get(normalizedKey) : undefined;
}
```

Both raw-trimmed and lowercased variants are stored. Lookup prefers exact match, falls back to lowercase. This matters because `unique_coupon_name` in coupon metadata is sometimes typed with slightly different casing than the pool's canonical name.

#### Persistence (lines 160–236)

- `saveMaps()` — writes 6 JSON files.
- `loadMaps()` — reads each if it exists; survives missing files silently (fresh run).
- `clearAllMaps()` — clears in-memory **and** deletes the files. Only called by `--clean`.

### 5b. `strapi-insert.ts` — every insert goes through here

#### `generateDocumentId` (lines 6–12)

```ts
export function generateDocumentId(sourceKey?: string): string {
  if (sourceKey) {
    const hash = createHash("sha256").update(sourceKey).digest("hex").slice(0, 24);
    return `wp_${hash}`;
  }
  return createId();
}
```

This is the idempotency keystone:
- With `sourceKey` → `wp_<24-char-sha256>` (27 chars total). Same WP row ⇒ same `document_id` across runs.
- Without `sourceKey` → random CUID v2. Used only for `files` (since attachment dedup is by hash, not document_id).

Document-id conventions across phases:

| Phase | Scheme | Example |
|---|---|---|
| 03 | `term:{table}:{wpTermId}` | `term:stores:42` |
| 05 | `pool:{wpPoolId}` | `pool:7` |
| 06 | `unique-code:{wpCodeId}` | `unique-code:15023` |
| 06a | `user:{wpUserId}` | `user:1` |
| 07 | `coupon:{wpPostId}` | `coupon:3110` |
| 08 | `deal:{wpPostId}` | `deal:3299` |
| 02 | (random CUID) | `xy7g8h9…` |

Everything that isn't a media file gets the `wp_` prefix. That's how `--clean` distinguishes migrated admin users from the super admin.

#### `batchInsert` (lines 30–82)

Core generic insert:

```ts
const chunkSize = Math.floor(65535 / columns.length);
// ... for each chunk, build:
INSERT INTO "${table}" (…columns…)
VALUES (…per-row placeholders…), (…), …
${conflictClause}
RETURNING *
```

The 65535 constant is PostgreSQL's hard limit on parameters per query. We chunk by `floor(65535 / columns.length)` so we never exceed it. `conflictClause` is either empty or `ON CONFLICT ("{conflictColumn}") DO NOTHING`.

#### `insertComponent` (lines 98–147)

Strapi v5 stores components in two tables: a *data* table (e.g. `components_shared_seos` holds the SEO fields) and a *link* table named `{entity}_cmps` (e.g. `stores_cmps`) that joins component rows to their owning entity. This helper:

1. Pre-checks the link table so repeated calls don't duplicate:
   ```sql
   SELECT "cmp_id" FROM "${cmpTable}"
   WHERE "entity_id" = $1
     AND "field" = $2
     AND "component_type" = $3
     AND "order" = $4
   LIMIT 1
   ```
2. Inserts the component row: `INSERT INTO "${componentTable}" (…) VALUES (…) RETURNING id`
3. Inserts the link row:
   ```sql
   INSERT INTO "${cmpTable}" ("entity_id", "cmp_id", "component_type", "field", "order")
   VALUES ($1, $2, $3, $4, $5)
   ```

The `{entity}_cmps` tables are a Strapi v5 invariant — every content type that owns components has one.

#### `insertLink` (lines 152–167)

```ts
export async function insertLink(linkTable: string, columns: Record<string, number>): Promise<void> {
  // ... builds ...
  INSERT INTO "${linkTable}" (…)
  VALUES (…)
  ON CONFLICT DO NOTHING
}
```

Generic M2M link insert. Callers pass the column map explicitly, e.g.:
```ts
await insertLink("coupons_stores_lnk", {
  coupon_id: entityId,
  store_id: ref.id,
  coupon_ord: 1,
});
```

#### `linkMedia` (lines 172–186)

```ts
export async function linkMedia(
  fileId: number, relatedId: number, relatedType: string, field: string, order: number = 1
): Promise<void> {
  // ...
  INSERT INTO "files_related_mph" ("file_id", "related_id", "related_type", "field", "order")
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT DO NOTHING
}
```

`files_related_mph` is Strapi v5's polymorphic media join (the `_mph` suffix = "morph"). Unlike typed link tables, one row here can point at any entity by `related_type` (e.g. `"api::coupon.coupon"`) + `related_id`, plus the schema field name (`"image"`, `"logo"`, `"dealImage"`).

### 5c. `sanitize.ts`

```ts
export function clean(val): string | null {
  if (val == null) return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function cleanSlug(val): string {
  if (!val) return "";
  return val
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")        // spaces/underscores → hyphen
    .replace(/[^a-z0-9-]/g, "")     // strip special chars
    .replace(/-{2,}/g, "-")         // collapse multiple hyphens
    .replace(/^-|-$/g, "");         // strip leading/trailing hyphens
}

export function cleanCode(val): string | null { /* like clean() but named for coupon codes */ }
```

### 5d. `wp-dates.ts`

Three normalizers. All return an ISO string or `null`.

- `normalizeWpDate(value)` (lines 9–15) — WP's GMT columns (`post_date_gmt`, `post_modified_gmt`, `user_registered`). Assumes UTC if no offset present:
  ```ts
  const iso = value.replace(" ", "T");
  const hasOffset = iso.endsWith("Z") || /[+\-]\d{2}:?\d{2}$/.test(iso);
  const date = new Date(hasOffset ? iso : `${iso}Z`);
  ```
- `normalizeWpLocalDate(value)` (lines 24–29) — non-GMT columns (`post_date`). Parses as local time (inherits the Node process's TZ). Only used as a fallback when the GMT column is empty.
- `parseExpiryDate(value)` (lines 34–45) — WP expiration meta is sometimes a unix timestamp (> 1e9), sometimes a date string:
  ```ts
  const ts = parseInt(value, 10);
  if (!isNaN(ts) && ts > 1_000_000_000) return new Date(ts * 1000).toISOString();
  if (value.includes("-")) {
    const d = new Date(value);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
  ```

### 5e. `content-status.ts`

```ts
export function computeMigrationStatus(input): { contentStatus, scheduledAt, publishedAt } {
  const now = input.now ?? new Date();
  const postDate = new Date(input.postDate);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

  if (expiresAt && !isNaN(expiresAt.getTime()) && expiresAt <= now) {
    return { contentStatus: "expired", scheduledAt: null, publishedAt: input.postDate };
  }

  const isScheduled = input.postStatus === "future" || postDate > now;
  if (isScheduled) {
    return { contentStatus: "scheduled", scheduledAt: postDate.toISOString(), publishedAt: null };
  }

  return { contentStatus: "published", scheduledAt: null, publishedAt: input.postDate };
}
```

Precedence: expired > scheduled > published. `expired` keeps `publishedAt` — the coupon was live at some point, we just mark it as no longer active.

### 5f. `admin-auth.ts`

```ts
export function generateResetToken(): string {
  return randomBytes(20).toString("hex");           // 40-char hex
}

export function hashRandomPassword(): string {
  return bcrypt.hashSync(randomBytes(32).toString("hex"), 10);  // cost 10
}

export function splitDisplayName(displayName, fallback) {
  const raw = (displayName ?? "").trim();
  if (!raw) return { firstname: fallback, lastname: null };
  const idx = raw.indexOf(" ");
  if (idx === -1) return { firstname: raw, lastname: null };
  return { firstname: raw.slice(0, idx), lastname: raw.slice(idx + 1).trim() || null };
}
```

Every migrated admin user gets a random password they can never guess, plus a reset token so the first login flow is "click the forgot password email."

### 5g. `media-resolver.ts`

Two exports:

```ts
export async function resolveMediaRef(value): Promise<number | undefined> {
  if (value === null || value === undefined || value === "") return undefined;
  const strVal = String(value).trim();
  if (!strVal) return undefined;

  const numVal = Number(strVal);
  if (!isNaN(numVal) && numVal > 0) {
    const existing = getMediaMapping(numVal);
    if (existing) return existing;
    const fileId = await uploadMediaOnDemand(numVal);
    if (!fileId) logger.debug(`Media ref ${numVal} could not be resolved or uploaded`);
    return fileId;
  }

  logger.debug(`Media ref is a URL, cannot resolve: ${strVal.substring(0, 80)}`);
  return undefined;
}
```

- Numeric IDs flow through: map hit → return; map miss → call `uploadMediaOnDemand` in phase 02.
- URLs are dropped silently with a debug log. WP's media fields normally store attachment IDs; when a URL slips in (ACF gallery, rich text with pasted URLs), we can't resolve it to a Strapi file record.

`buildFilesMorphInsert` (lines 41–61) is a row-object helper for the rare case we want to batch-insert into `files_related_mph`. Current callers use `linkMedia` instead.

### 5h. `acf-repeater.ts`

ACF stores repeater fields as flat meta keys. For FAQ:
```
faq_items                      = "3"
faq_items_0_faq_question       = "What is…?"
faq_items_0_faq_answer         = "It is…"
faq_items_1_faq_question       = …
```

`parseFaqRepeater` reads the count row, then loops `faq_items_<i>_faq_question` / `..._faq_answer` up to `count`. Skips items missing either half with a warning.

### 5i. `yoast-vars.ts`

Resolves Yoast's `%%variable%%` templating. Hardcoded values:

```ts
template
  .replace(/%%title%%/g, entityTitle)
  .replace(/%%sep%%/g, "-")
  .replace(/%%sitename%%/g, "CouponzGuru")
  .replace(/%%page%%/g, "")
  .replace(/%%primary_category%%/g, "")
  .replace(/%%category%%/g, "")
  .replace(/%%tag%%/g, "")
  .replace(/%%term_title%%/g, entityTitle)
  .replace(/%%term_description%%/g, "")
  .replace(/%%excerpt%%/g, "")
  .replace(/%%date%%/g, "")
  .replace(/%%year%%/g, new Date().getFullYear().toString())
  .replace(/%%currentyear%%/g, new Date().getFullYear().toString())
  .replace(/%%cf_\w+%%/g, "")      // custom fields
  .replace(/%%\w+%%/g, "")         // any remaining variables
  .replace(/\s{2,}/g, " ")         // collapse whitespace
  .trim();
```

Note the site name is baked in as `"CouponzGuru"`.

### 5j. `slug-dedup.ts`

A per-table `Map<table, Set<slug>>` that guarantees slug uniqueness within a single process run:

```ts
export function deduplicateSlug(slug: string, table: string): string {
  if (!usedSlugs.has(table)) usedSlugs.set(table, new Set());
  const set = usedSlugs.get(table)!;
  let candidate = slug;
  let counter = 1;
  while (set.has(candidate)) {
    candidate = `${slug}-${counter}`;
    counter++;
  }
  set.add(candidate);
  return candidate;
}
```

If two WP terms produce the same slug (e.g. hierarchical collision), the second becomes `slug-1`, the third `slug-2`, etc.

### 5k. `logger.ts`

Winston with three transports: colorized console (short timestamp), `migration.log` (full timestamp), `migration-errors.log` (errors only). Log level from `config.logLevel`.

### 5l. `checkpoint.ts`

Three tiny helpers:
- `isPhaseComplete(phase)` — does `.checkpoints/{phase}.json` exist?
- `markPhaseComplete(phase, summary?)` — write `{ phase, completedAt, ...summary }`.
- `clearCheckpoints()` — delete every `*.json` in `.checkpoints/` except `*Map.json` files. Used by `--clean` to wipe checkpoint markers without nuking the id maps (which are deleted separately via `clearAllMaps`).

---

## 6. Phase-by-Phase Reference

### 6a. Phase 00 — Preflight (`00-preflight.ts`)

Read-only safety checks. Throws if anything is wrong. Skipped by checkpoint (`skipCheckpoint: true`).

1. **MySQL probe**: `SELECT VERSION() AS v`.
2. **Required WP tables** via `information_schema`:
   ```sql
   SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE()
   ```
   Asserts `wp_posts`, `wp_postmeta`, `wp_terms`, `wp_term_taxonomy`, `wp_term_relationships`, `wp_termmeta`.
3. **Optional WP tables** — just logs presence: `wp_uc_coupons`, `wp_uc_codes`, `wp_yoast_indexable`.
4. **Postgres probe**: `SELECT version()`.
5. **Required PG tables**:
   ```sql
   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
   ```
   Asserts `stores`, `brands`, `categories`, `banks`, `coupons`, `deals`, `unique_coupon_pools`, `unique_codes`, `files`, `files_related_mph`, `components_shared_seos`, `components_shared_faq_items`.
6. **Create unique indexes** (lines 91–103):
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS "${table}_document_id_uq" ON "${table}" ("document_id");
   CREATE UNIQUE INDEX IF NOT EXISTS "files_hash_uq" ON "files" ("hash") WHERE "hash" IS NOT NULL;
   CREATE UNIQUE INDEX IF NOT EXISTS "files_related_mph_uq"
     ON "files_related_mph" ("file_id", "related_id", "related_type", "field");
   ```
   These are what make `ON CONFLICT DO NOTHING` work — without a unique constraint on the conflict column, PG would raise an error on conflict.
7. **Link-table discovery** — logs every table ending in `_lnk`, `_links`, or `_cmps` so you can eyeball the schema.
8. **WP summary** — counts of terms (broken down by `choose_type`), published posts, deals, coupons (derived), pools, codes, attachments, and posts with expiry metadata.

### 6b. Phase 01 — Media Inventory (`01-media-inventory.ts`)

Scans WordPress for image attachments and builds an in-memory inventory for phase 02 to draw from.

**Source** (lines 29–41):
```sql
SELECT ID, guid, post_title, post_mime_type
FROM wp_posts
WHERE post_type = 'attachment'
  AND post_mime_type LIKE 'image/%'
ORDER BY ID
```

Only images — PDFs, videos, etc. don't make it into Strapi.

**Alt text** (lines 46–54):
```sql
SELECT post_id, meta_value
FROM wp_postmeta
WHERE meta_key = '_wp_attachment_image_alt'
AND post_id IN (SELECT ID FROM wp_posts WHERE post_type = 'attachment')
```
Fetched in one round trip and joined in memory.

**Plugin blacklist** (lines 20–24):
```ts
const SKIP_DIRS = [
  "backup", "ninja-popups", "elementor", "wpallimport", "wp-migrate-db",
  "sucuri", "wpcode", "awsm-job-openings", "ulp", "really-simple-ssl",
  "cp_preset_screenshots", "wpseo-redirects", "maxmegamenu",
];
```

For every attachment, the GUID URL is sliced at `/uploads/` to get a relative path like `2024/01/image.jpg`. The *first segment* of that path (`"2024"` in the healthy case) is checked against `SKIP_DIRS`. Plugin subdirectories get dropped entirely — they're backup artifacts, popup assets, migration-tool dumps, etc., all of which would only clutter Strapi's media library. Counter `skippedPlugin` logs the total.

For each kept attachment:
- `localPath = path.join(config.wpUploadsDir, relativePath)`
- `exists = fs.existsSync(localPath)` — missing-local is kept in the inventory (as `localPath: null`) but counted separately. Such items can't be uploaded later (phase 02 requires local bytes to compute a hash), but they *might* be attachments that exist only by reference, in which case phase 02 will simply fail to upload them and downstream phases will skip them with a debug log.

Logged summary (lines 104–108):
```
Images found locally: N
Images missing locally: N
Skipped (plugin dirs): N
Total to upload: N
```

`getOrLoadMediaItem(id)` (lines 115–150) is the late-binding fallback. If phase 07 or 08 asks to resolve an attachment not in the current inventory (e.g. when running phase 08 standalone without phase 01), we issue a single-row query and fold it into the same shape.

### 6c. Phase 02 — Media Upload (on-demand) (`02-media-upload.ts`)

`runMediaUpload()` does almost nothing — just loads the hash cache. Actual uploads happen when content phases call `resolveMediaRef` → `uploadMediaOnDemand`.

**Hash cache preload** (lines 65–74):
```ts
const rows = await pgQuery<{ hash: string; id: number }>(
  `SELECT hash, id FROM files WHERE hash IS NOT NULL`
);
for (const row of rows) existingHashes.set(row.hash, row.id);
```

So re-running never re-uploads an image that's already in Strapi (whether inserted earlier in this run or from a previous run).

**Upload logic** (`uploadFileFromDisk` / `doUploadFileFromDisk`):

1. `getMediaMapping(attachmentId)` — already uploaded in this process? Return.
2. `getOrLoadMediaItem(attachmentId)` — inventory hit or fallback fetch. No local path → bail (`undefined`).
3. `fs.readFileSync(filePath)` once → `hashBuffer` → SHA-256 truncated to 16 hex chars. The hash is always taken from the **pre-optimization source bytes**, so dedup/idempotency is unchanged by re-encoding.
4. `existingHashes.has(hash)` → record mapping and return the existing file id (dedup). Uploads are also deduped by resolved local path via an in-flight map, so concurrent posts referencing the same image share one upload.
5. **Optimize** (S3 path only) — supported raster MIMEs (jpeg/png/webp/avif/tiff) run through `optimizeOriginal`: EXIF orientation baked in, downscaled to fit 1920×1920, jpeg/png converted to webp, webp/avif/tiff re-encoded at quality 80. gif/svg/animated/undecodable inputs return `null` and pass through untouched (`formats` stays NULL). The optimized output replaces `ext`/`mime`/`width`/`height`/`size`; the pre-optimization bytes are kept as the AVIF encode source.
6. Upload:
   - **S3** (when `config.s3.bucket` and `config.s3.accessKeyId` are set) — an SEO-friendly per-image folder key, then the responsive variants:
     ```ts
     const slug = slugifyFileName(nameWithoutExt);
     const imageFolder = `${slug}-${hash.slice(0, 8)}`;
     const s3Key = `${rootPath}${imageFolder}/${slug}${ext}`;
     // uploads/myntra-coupon-codes-a1b2c3d4/myntra-coupon-codes.webp
     ```
     The original is PUT with `Cache-Control: public, max-age=31536000, immutable`. SVG/markup-capable MIME types are forced to `application/octet-stream` + attachment disposition so they can never execute inline. When the file was optimized, `generateStrapiFormats` then renders the matrix (`thumbnail`/`xsmall`/`small`/`medium`/`large`, each key only when the master exceeds that size) plus AVIF twins for webp masters, uploads every variant under the same folder, and returns the `files.formats` JSON. Immutable cache-control is safe because the content hash sits in the folder segment, so the key changes when the content changes.
   - **Local fallback** (no S3 config): no optimization, no variants. Records a `local` provider row at `/uploads/${hash}_${nameWithoutExt}${ext}` pointing at `sourcePath`; phase 11 does the actual copy.
7. The Strapi `files` insert:
   ```sql
   INSERT INTO files (
     document_id, name, alternative_text, caption, width, height,
     formats, ext, mime, size, hash, url, provider, provider_metadata,
     folder_path, created_at, updated_at, published_at
   ) VALUES (
     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW(), NOW()
   ) RETURNING id
   ```
   `formats` is the generated JSON (or NULL). `size` is stored in KB (Strapi convention). `folder_path` is always `"/"` — Strapi's root folder.
8. Record the mapping and bump stats (`setMediaMapping`, `existingHashes.set`, `uploadStats.uploaded++`).

All optimize/variant/twin knobs (breakpoints, thumbnail box, AVIF quality/effort) come from `cguruadmin/src/constants/image.ts`, re-exported through `utils/image-optimizer.ts` and shared with the admin upload extension.

**`clearS3Bucket()`** — paginated `ListObjectsV2` + `DeleteObjects` scoped to `config.s3.rootPath` (refuses to run when the root path is empty). Invoked from `--clean`.

### 6d. Phase 03 — Taxonomies (`03-taxonomies.ts`)

Migrates WP `category`-taxonomy terms into four Strapi tables based on the `choose_type` termmeta.

**Source** (lines 51–74):
```sql
SELECT
  t.term_id,
  t.name,
  t.slug,
  tt.parent,
  tt.description,
  tt.count,
  MAX(CASE WHEN tm.meta_key='choose_type' THEN tm.meta_value END) AS choose_type,
  MAX(CASE WHEN tm.meta_key='store_short_description' THEN tm.meta_value END) AS short_desc,
  MAX(CASE WHEN tm.meta_key='store_cat_image' THEN tm.meta_value END) AS image_ref,
  MAX(CASE WHEN tm.meta_key='store_image_alt' THEN tm.meta_value END) AS image_alt,
  MAX(CASE WHEN tm.meta_key='enable_faq_schema' THEN tm.meta_value END) AS faq_enabled,
  MAX(CASE WHEN pm.meta_key='_kksr_avg' THEN pm.meta_value END) AS rating_avg,
  MAX(CASE WHEN pm.meta_key='_kksr_casts' THEN pm.meta_value END) AS rating_count
FROM wp_terms t
JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy = 'category'
LEFT JOIN wp_termmeta tm ON t.term_id = tm.term_id
  AND tm.meta_key IN ('choose_type','store_short_description','store_cat_image','store_image_alt','enable_faq_schema')
LEFT JOIN wp_postmeta pm ON t.term_id = pm.post_id
  AND pm.meta_key IN ('_kksr_avg','_kksr_casts')
GROUP BY t.term_id, t.name, t.slug, tt.parent, tt.description, tt.count
ORDER BY t.term_id
```

One round-trip gets everything per term: core columns, termmeta fields (via `MAX(CASE WHEN …)` pivot), and the ratings from `wp_postmeta` (the KK-Star-Ratings plugin stores them keyed by `post_id = term_id`).

**Type mapping** (lines 33–45):
```ts
const TYPE_TO_TABLE = { Store: "stores", Brand: "brands", Category: "categories", Bank: "banks" };
const TYPE_TO_STRAPI_TYPE = {
  Store: "api::store.store",
  Brand: "api::brand.brand",
  Category: "api::category.category",
  Bank: "api::bank.bank",
};
```

Missing `choose_type` defaults to `Store` with a warning log.

**Hierarchical slugs** (lines 79–100):
```ts
function buildFullSlug(termId: number): string {
  const parts: string[] = [];
  let current: number | undefined = termId;
  const visited = new Set<number>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const s = slugByTermId.get(current);
    if (s) parts.unshift(s);
    current = parentByTermId.get(current);
  }
  return parts.join("/");
}
```

Walks up the WP parent chain producing `"grandparent/parent/child"`. The `visited` set protects against cycles in malformed data. Each hierarchical slug is then fed through `deduplicateSlug(…, table)` before the insert.

**FAQ meta** (lines 120–145):
```sql
SELECT term_id, meta_key, meta_value
FROM wp_termmeta
WHERE meta_key LIKE 'faq_items%'
ORDER BY term_id, meta_key
```
Grouped by `term_id` and parsed by `parseFaqRepeater` (§5h).

**Yoast SEO** (lines 147–173):
```sql
SELECT term_id, meta_key, meta_value
FROM wp_termmeta
WHERE meta_key IN ('_yoast_wpseo_title', '_yoast_wpseo_metadesc')
ORDER BY term_id
```

**Per-term insert** (lines 267–273):
```sql
INSERT INTO "${table}" (
  "document_id", "name", "slug", "description", "short_description",
  [ "logo_alt", ]  -- only for non-categories
  "rating_average", "rating_count", "faq_enabled",
  "published_at", "created_at", "updated_at", "locale"
) VALUES ($1, …)
ON CONFLICT ("document_id") DO NOTHING
RETURNING id
```

Categories don't carry `logo_alt` because they use `icon` instead of `logo` as the media field.

`entityId` comes from either `RETURNING id` or — on conflict — `getEntityIdByDocumentId(table, documentId)`. Then:

```ts
setTermMapping(term.term_id, { id: entityId, documentId, type: strapiType, table });
```

**Media link** (lines 291–295):
```ts
const fileId = await resolveMediaRef(term.image_ref);
if (fileId) {
  const field = isCategory ? "icon" : "logo";
  await linkMedia(fileId, entityId, strapiType, field);
}
```

**FAQ components** (lines 297–317) — only when `faqEnabled`:
```ts
for (let i = 0; i < faqItems.length; i++) {
  await insertComponent(
    "components_shared_faq_items",
    { question: faqItems[i].question, answer: faqItems[i].answer },
    table, entityId, "faqs", "shared.faq-item", i + 1
  );
}
```

**SEO component** (lines 319–339) — when either title or description exists:
```ts
await insertComponent(
  "components_shared_seos",
  { meta_title, meta_description, canonical_url: null },
  table, entityId, "seo", "shared.seo"
);
```

### 6f. Phase 05 — Coupon Pools (`05-pools.ts`)

Existence probe:
```sql
SELECT COUNT(*) AS c
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'wp_uc_coupons'
```

Skips if the Unique Coupons plugin isn't installed.

**Source** (lines 28–36):
```sql
SELECT
  uc.id, uc.name,
  (SELECT COUNT(*) FROM wp_uc_codes c WHERE c.coupon_id = uc.id) AS total_codes,
  (SELECT COUNT(*) FROM wp_uc_codes c WHERE c.coupon_id = uc.id AND c.is_used = 1) AS used_codes
FROM wp_uc_coupons uc
ORDER BY uc.id
```

Correlated subqueries compute the code counts up front so we don't need a second pass.

**Target** (lines 46–53):
```sql
INSERT INTO "unique_coupon_pools" (
  "document_id", "name", "total_codes", "used_codes",
  "created_at", "updated_at", "published_at", "locale"
) VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), $5)
ON CONFLICT ("document_id") DO NOTHING
RETURNING id
```

Populates both `poolIdMap` (by numeric id) and `poolNameMap` (by name, raw + lowercased).

### 6g. Phase 06 — Unique Codes (`06-codes.ts`)

Batched migration because the `wp_uc_codes` table can be hundreds of thousands of rows.

**Batch loop** (lines 37–141):

```ts
while (offset < total) {
  batchNum++;
  const codes = await wpQuery(`
    SELECT id, coupon_id, code, is_used, version
    FROM wp_uc_codes
    ORDER BY id
    LIMIT ${batchSize} OFFSET ${offset}
  `);
  // ... see below ...
  offset += batchSize;
}
```

**Bulk code insert** (lines 71–77):

```sql
INSERT INTO "unique_codes" ("document_id", "code", "is_used", "version", "created_at", "updated_at", "published_at", "locale")
VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), $5), ($6, …), …
ON CONFLICT ("document_id") DO NOTHING
RETURNING id, document_id, code
```

(With 5 parameters per row — the `NOW()` literals don't take parameters.)

**ID resolution** (lines 81–89) — `RETURNING` only returns newly-inserted rows. For the rest, look up by the deterministic `document_id`:

```sql
SELECT id, document_id
FROM "unique_codes"
WHERE document_id = ANY($1::text[])
```

`ANY($1::text[])` is PG's array-parameter idiom — we pass the array of document ids as a single parameter.

**Pool linking** (lines 92–130) — for each code, look up the pool and emit:

```sql
INSERT INTO "unique_codes_pool_lnk" ("unique_code_id", "unique_coupon_pool_id", "unique_code_ord")
VALUES ($1, $2, $3), ($4, $5, $6), …
ON CONFLICT DO NOTHING
```

Sub-batched at `floor(65535 / 3) = 21845` rows per INSERT to stay under PG's 65535-parameter limit. Placeholders are renumbered per chunk so the values array lines up (lines 117–122).

### 6h. Phase 06a — Users (`06a-users.ts`)

New phase (recent feature). Migrates WP post authors into Strapi admin users with the Editor role, then backfills `created_by_id` / `updated_by_id` on every migrated content row.

**Prerequisite check** (lines 24–33):

```sql
SELECT id FROM "admin_roles" WHERE code = $1 LIMIT 1
```
(with `["strapi-editor"]`). Throws with remediation text if the role doesn't exist:
```
admin_roles 'strapi-editor' not found — start Strapi at least once so default roles are created, then rerun this phase
```

**Source** (lines 44–59):

```sql
SELECT u.ID, u.user_login, u.user_email,
       CASE WHEN CAST(u.user_registered AS CHAR) = '0000-00-00 00:00:00'
            THEN NULL ELSE CAST(u.user_registered AS CHAR) END AS user_registered,
       u.display_name, u.user_nicename,
       (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'first_name' LIMIT 1) AS first_name,
       (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'last_name' LIMIT 1) AS last_name
FROM wp_users u
WHERE u.ID IN (
  SELECT DISTINCT p.post_author
  FROM wp_posts p
  WHERE p.post_type = 'post'
    AND p.post_status IN ('publish', 'future')
)
ORDER BY u.ID
```

- Only active post authors (not every WP user — many would be spam registrations).
- `CAST AS CHAR` is MySQL belt-and-suspenders: even with `dateStrings: true` at the connection level, some server builds still return datetime objects for the GMT-less `user_registered` column.
- `'0000-00-00 00:00:00'` → `NULL` mapping covers WP's zero-date convention.
- First/last names come from `wp_usermeta` subselects.

**Concurrency** (line 67):

```ts
const limit = pLimit(10);
```
10 concurrent user upserts.

**Name resolution** (lines 226–256):

Priority order:
1. `wpFirstName` from usermeta → use that + `wpLastName`.
2. Otherwise, `displayName` — but only if it's not the user's email and doesn't contain `@` (many WP sites default display_name to the email).
3. Fallback chain: `user_nicename` → `user_login` → `User{ID}`.

`splitDisplayName` splits on first space.

**Upsert logic** (lines 90–141):

1. Look up by email:
   ```sql
   SELECT id, document_id FROM "admin_users" WHERE email = $1 LIMIT 1
   ```
2. **If no match → INSERT** (lines 99–127):
   ```sql
   INSERT INTO "admin_users" (
     "document_id", "firstname", "lastname", "username", "email",
     "password", "reset_password_token", "registration_token",
     "is_active", "blocked", "prefered_language",
     "published_at", "created_at", "updated_at", "locale"
   ) VALUES (
     $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
   )
   RETURNING id
   ```
   - `password` = `hashRandomPassword()` (unknowable bcrypt).
   - `reset_password_token` = `generateResetToken()` (ready for forgot-password flow).
   - `is_active` = true, `blocked` = false.
   - `created_at` / `updated_at` = normalized `user_registered` or current time.
3. **If match with `wp_`-prefixed document_id → UPDATE** (lines 132–140):
   ```sql
   UPDATE "admin_users"
   SET "firstname" = $1,
       "lastname" = $2,
       "username" = COALESCE(NULLIF("username", ''), $3),
       "updated_at" = NOW()
   WHERE "id" = $4
   ```
   The `COALESCE(NULLIF(..., ''), $3)` preserves any non-empty existing username.
4. **If match with non-`wp_` document_id**: this is a manually-created Strapi user who happens to share the WP email. Do nothing to the user row; fall through and just wire the role link and the userIdMap entry.

**Role link** (lines 152–161):

```sql
SELECT id FROM "admin_users_roles_lnk" WHERE user_id = $1 AND role_id = $2 LIMIT 1
```
If none, insert:
```sql
INSERT INTO "admin_users_roles_lnk" ("user_id", "role_id") VALUES ($1, $2)
```

`setUserMapping(user.ID, adminUserId)` populates `userIdMap` so phases 07 and 08 can route `post_author` to `created_by_id`.

**Failure guard** (lines 178–182):

```ts
if (inserted === 0 && failed > 0) {
  throw new Error(`Users phase failed: ${failed}/${users.length} inserts errored, 0 succeeded`);
}
```
A single skip for a missing email is tolerated. Total failure is a hard stop.

#### Creator backfill (`backfillCreators`, lines 187–224)

After user migration, patch `created_by_id` / `updated_by_id` on these entity types:

1. **Deals & coupons** (lines 190–217):
   ```sql
   SELECT p.ID, p.post_author,
          (SELECT meta_value FROM wp_postmeta
             WHERE post_id = p.ID AND meta_key = 'is_deal' LIMIT 1) AS is_deal
   FROM wp_posts p
   WHERE p.post_type = 'post'
     AND p.post_status IN ('publish', 'future')
   ```
   For each row, resolve the author via `userIdMap`, compute the deterministic `deal:{ID}` or `coupon:{ID}` document_id, and bucket into `dealPairs` / `couponPairs`.

2. **Taxonomies** (`backfillTaxonomyCreators`, lines 258–306):
   ```sql
   SELECT tt.term_id, p.post_author, p.ID AS post_id
   FROM wp_term_taxonomy tt
   JOIN wp_term_relationships tr ON tr.term_taxonomy_id = tt.term_taxonomy_id
   JOIN wp_posts p ON p.ID = tr.object_id
   WHERE tt.taxonomy = 'category'
     AND p.post_type = 'post'
     AND p.post_status IN ('publish', 'future')
   ORDER BY tt.term_id,
            COALESCE(p.post_modified_gmt, p.post_date_gmt, p.post_modified, p.post_date) DESC,
            p.ID DESC
   ```
   "Latest post authoring the term" heuristic: we group by term and take the author of the most recently-modified post in that term. Then route via `ensureTermMapping` to determine which of the four taxonomy tables the term lives in, and accumulate pairs per-table.

**`applyCreatorUpdates`** (lines 354–388) — the single UPDATE helper used for all of them:

```ts
for (let i = 0; i < pairs.length; i += CHUNK) {
  const chunk = pairs.slice(i, i + CHUNK);
  const values: any[] = [];
  const placeholders = chunk
    .map((pair, idx) => {
      const p1 = idx * 2 + 1;
      const p2 = idx * 2 + 2;
      values.push(pair[0], pair[1]);
      return `($${p1}::text, $${p2}::integer)`;
    })
    .join(", ");

  const sql = `
    UPDATE "${table}" AS t
    SET created_by_id = v.admin_id,
        updated_by_id = v.admin_id
    FROM (VALUES ${placeholders}) AS v(document_id, admin_id)
    WHERE t.document_id = v.document_id
  `;
  const result = await pool.query(sql, values);
  total += result.rowCount ?? 0;
}
```

- `CHUNK = 500` — 1000 parameters per batch, well under the limit.
- The `VALUES (…) AS v(document_id, admin_id)` pattern is PG's way of doing a bulk join-update without a temp table.
- `::text` / `::integer` casts tell PG the types explicitly so it doesn't have to infer from literals.

### 6i. Phase 07 — Coupons (`07-coupons.ts`)

**Source** (lines 48–63):

```sql
SELECT p.ID, p.post_title, p.post_name, p.post_content,
       CASE WHEN CAST(p.post_date AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date AS CHAR) END AS post_date,
       CASE WHEN CAST(p.post_date_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date_gmt AS CHAR) END AS post_date_gmt,
       CASE WHEN CAST(p.post_modified AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified AS CHAR) END AS post_modified,
       CASE WHEN CAST(p.post_modified_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified_gmt AS CHAR) END AS post_modified_gmt,
       p.post_status, p.post_author
FROM wp_posts p
WHERE p.post_type = 'post'
  AND p.post_status IN ('publish', 'future')
  AND p.ID NOT IN (
    SELECT post_id FROM wp_postmeta
    WHERE meta_key = 'is_deal' AND meta_value = 'yes'
  )
ORDER BY p.ID
```

Coupons = posts that are NOT marked as deals. The zero-date `CASE`s run once per row for consistency with the deal query.

**Bulk prefetch** (lines 71–76) — all per-post data in parallel:
```ts
const [allMeta, allRelations, primaryTerms] = await Promise.all([
  getPostMetaBulk(postIds),
  getTermRelationsBulk(postIds),
  getPrimaryTerms(postIds),
]);
```

##### Meta (`getPostMetaBulk`, lines 291–311):
```sql
SELECT post_id, meta_key, meta_value
FROM wp_postmeta
WHERE post_id IN (?, ?, …)
AND meta_key IN (
  'code', 'link', 'popular_coupon', 'image',
  'is_deal', 'unique_coupon', 'unique_coupon_name',
  '_action_manager_date', '_expiration-date', '_expiration-date-status', 'expiration-date'
)
```
All eleven meta keys we care about for coupons, grouped by post_id in memory.

##### Category relations (`getTermRelationsBulk`):
```sql
SELECT tr.object_id, tt.term_id
FROM wp_term_relationships tr
JOIN wp_term_taxonomy tt ON tr.term_taxonomy_id = tt.term_taxonomy_id AND tt.taxonomy = 'category'
WHERE tr.object_id IN (?, …)
```

##### Primary term (`getPrimaryTerms`):
```sql
SELECT post_id, term_id
FROM wp_yoast_primary_term
WHERE post_id IN (?, …)
AND taxonomy = 'category'
```
Wrapped in try/catch — Yoast-less sites just get an empty map.

**Per-post processing** (lines 82–213) with `pLimit(20)`:

Date resolution (lines 94–101):
```ts
const createdAt =
  normalizeWpDate(post.post_date_gmt) ||
  normalizeWpLocalDate(post.post_date) ||
  new Date().toISOString();
const updatedAt =
  normalizeWpDate(post.post_modified_gmt) ||
  normalizeWpLocalDate(post.post_modified) ||
  createdAt;
```
Always prefer GMT; fall back to local; fall back to now.

Expiry (`getExpiryRaw`, lines 368–378):
```ts
if (meta["_action_manager_date"]) return meta["_action_manager_date"];
if (meta["_expiration-date-status"] && meta["_expiration-date-status"] !== "saved") return undefined;
return meta["_expiration-date"] || meta["expiration-date"];
```
The `_action_manager_date` meta (from the Action Manager plugin) wins if present. Otherwise we check `_expiration-date-status` — only status `"saved"` means the expiration is live. Last resort: the raw `_expiration-date` or `expiration-date` strings.

Then `parseExpiryDate` (§5d) → `contentStatus` via `computeMigrationStatus` (§5e).

Author (line 112):
```ts
const authorId = getUserMapping(post.post_author) ?? null;
```
Silent null when the author wasn't in `wp_users` (or was skipped for missing email).

**Insert** (lines 114–145):

```sql
INSERT INTO "coupons" (
  "document_id", "title", "content",
  "code", "coupon_type", "is_popular",
  "affiliate_link", "expires_at", "scheduled_at", "content_status",
  "published_at", "created_at", "updated_at", "locale",
  "created_by_id", "updated_by_id"
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
)
ON CONFLICT ("document_id") DO NOTHING
RETURNING id
```

Field mapping:
| Strapi | WP source | Transform |
|---|---|---|
| `title` | `post_title` | `clean() ?? raw` |
| `content` | `post_content` | `stripShortcodes()` + `clean()` |
| `code` | `meta.code` | `cleanCode()` |
| `coupon_type` | `meta.unique_coupon` | `'1'` or `'true'` → `"unique"`, else `"static"` |
| `is_popular` | `meta.popular_coupon` | `=== '1'` |
| `affiliate_link` | `meta.link` | `clean()` |
| `expires_at` | `_action_manager_date` / `_expiration-date` / `expiration-date` | `parseExpiryDate()` |
| `scheduled_at`, `content_status`, `published_at` | computed | via `computeMigrationStatus()` |
| `created_at`, `updated_at` | `post_date_gmt`, `post_modified_gmt` | with local fallbacks |
| `created_by_id`, `updated_by_id` | `post_author` | via `userIdMap` |
| `locale` | — | always `null` |

`stripShortcodes` (lines 380–383):
```ts
return content.replace(/\[\/?\w+[^\]]*\]/g, "").trim();
```
Strips `[contact-form]`, `[gallery]`, `[/shortcode]` etc. — WP-isms that would render as literal text in Strapi.

##### Taxonomy wiring (`wireCouponRelations`, lines 219–258)

```ts
async function wireCouponRelations(entityId, termIds, primaryTermId) {
  const orderByType = new Map<string, number>();

  if (primaryTermId) {
    const ref = await ensureTermMapping(primaryTermId);
    if (ref) {
      const linkTable = getLinkTable("coupons", ref.table);
      if (linkTable) {
        const ord = (orderByType.get(ref.table) || 0) + 1;
        orderByType.set(ref.table, ord);
        await insertLink(linkTable.table, {
          [linkTable.couponCol]: entityId,
          [linkTable.termCol]: ref.id,
          coupon_ord: ord,
        });
      }
    }
  }

  for (const termId of termIds) {
    if (termId === primaryTermId) continue;
    const ref = await ensureTermMapping(termId);
    if (!ref) continue;
    const linkTable = getLinkTable("coupons", ref.table);
    if (linkTable) {
      const ord = (orderByType.get(ref.table) || 0) + 1;
      orderByType.set(ref.table, ord);
      await insertLink(linkTable.table, {
        [linkTable.couponCol]: entityId,
        [linkTable.termCol]: ref.id,
        coupon_ord: ord,
      });
    }
  }
}
```

- Primary term (from `wp_yoast_primary_term`) inserted first with `coupon_ord = 1`.
- Remaining terms follow in their natural order from `wp_term_relationships`, but skip duplicates of the primary.
- `orderByType` is a per-table counter, so stores and brands each restart at 1.

`getLinkTable` (lines 260–287) — string dispatch by target table:
```ts
stores:     { table: "coupons_stores_lnk",     couponCol: "coupon_id", termCol: "store_id" }
brands:     { table: "coupons_brands_lnk",     couponCol: "coupon_id", termCol: "brand_id" }
categories: { table: "coupons_categories_lnk", couponCol: "coupon_id", termCol: "category_id" }
banks:      { table: "coupons_banks_lnk",      couponCol: "coupon_id", termCol: "bank_id" }
```

##### Media wiring (lines 176–180):
```ts
const imageId = await resolveMediaRef(meta.image);
if (imageId) {
  await linkMedia(imageId, entityId, "api::coupon.coupon", "image");
}
```

##### Unique pool link (lines 182–200):
```ts
if (isUnique && uniqueCouponPoolName) {
  const poolRef = getPoolMappingByName(uniqueCouponPoolName);
  if (poolRef) {
    await insertLink("coupons_unique_coupon_pool_lnk", {
      coupon_id: entityId,
      unique_coupon_pool_id: poolRef.id,
      coupon_ord: 1,
    });
  } else {
    logger.warn(`Unique coupon pool not found for coupon ${post.ID} (${post.post_title}): ${uniqueCouponPoolName}`);
  }
} else if (isUnique) {
  logger.warn(`Unique coupon missing unique_coupon_name for coupon ${post.ID} …`);
}
```

### 6j. Phase 08 — Deals (`08-deals.ts`)

Same shape as coupons but with deal-specific fields and the `deal_store` merge.

**Source** (lines 42–53):
```sql
SELECT p.ID, p.post_title, p.post_name, p.post_content,
       CASE WHEN CAST(p.post_date AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date AS CHAR) END AS post_date,
       … (identical zero-date CASEs for the other 3 datetime columns) …
       p.post_status, p.post_author
FROM wp_posts p
JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = 'is_deal' AND pm.meta_value = 'yes'
WHERE p.post_type = 'post'
  AND p.post_status IN ('publish', 'future')
ORDER BY p.ID
```

The `JOIN` on `is_deal='yes'` is the partition line.

**Meta query** (lines 241–262) — same pattern as coupons but with deal-specific keys:
```sql
AND meta_key IN (
  'code', 'link', 'popular_coupon', 'image',
  'deal_mrp', 'deal_sale_price', 'deal_discount', 'deal_image', 'deal_store',
  '_action_manager_date', '_expiration-date', '_expiration-date-status', 'expiration-date'
)
```

**Insert** (lines 108–141):
```sql
INSERT INTO "deals" (
  "document_id", "title", "content", "code",
  "sale_price", "mrp", "discount",
  "is_popular", "affiliate_link", "expires_at", "scheduled_at", "content_status",
  "published_at", "created_at", "updated_at", "locale",
  "created_by_id", "updated_by_id"
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
)
ON CONFLICT ("document_id") DO NOTHING
RETURNING id
```

Differences vs coupons:
- `code` column is present (deal schema gained this field alongside coupons).
- `sale_price`, `mrp`, `discount` replace `coupon_type`.
- Content is stripped inline with the same regex, then Deal-specific validation
  rejects legacy scratch values (prices/codes) and empty rich-text wrappers.
  Only description-like content is stored in `Deal.content`.

**Taxonomy wiring diff** (lines 157–188): unlike coupons, deals use an inline closure with **per-table dedup**:

```ts
const orderByType = new Map<string, number>();
const linkedIdsByTable = new Map<string, Set<number>>();

const linkTerm = async (termId: number): Promise<void> => {
  const ref = await ensureTermMapping(termId);
  if (!ref) return;
  const linkInfo = getDealLinkTable(ref.table);
  if (!linkInfo) return;
  let linked = linkedIdsByTable.get(linkInfo.table);
  if (!linked) {
    linked = new Set();
    linkedIdsByTable.set(linkInfo.table, linked);
  }
  if (linked.has(ref.id)) return;  // ← the dedup step
  linked.add(ref.id);
  const ord = (orderByType.get(ref.table) || 0) + 1;
  orderByType.set(ref.table, ord);
  await insertLink(linkInfo.table, {
    [linkInfo.dealCol]: entityId,
    [linkInfo.termCol]: ref.id,
    deal_ord: ord,
  });
};

if (primaryTermId) await linkTerm(primaryTermId);
for (const termId of relations) {
  if (termId === primaryTermId) continue;
  await linkTerm(termId);
}
```

The `linkedIdsByTable` set is what makes the `deal_store` merge safe:

**`deal_store` merge** (lines 190–196):
```ts
if (meta.deal_store) {
  const storeTermId = parseInt(meta.deal_store, 10);
  if (!isNaN(storeTermId)) {
    await linkTerm(storeTermId);
  }
}
```
The `deal_store` postmeta holds a term_id (WP schema). Instead of the previous design (dedicated `deals_display_store_lnk`), we route it through `linkTerm()`, which:
1. Resolves the term_id to a store via `ensureTermMapping`.
2. Checks `linkedIdsByTable` — if that store was already linked as a taxonomy, skip (no duplicate row in `deals_stores_lnk`).
3. Otherwise inserts into `deals_stores_lnk`.

This is why `deals_display_store_lnk` was dropped from the schema and the `TRUNCATE` list: its data now lives in `deals_stores_lnk`.

**Media wiring with fallback** (lines 211–220):
```ts
const dealImageId = await resolveMediaRef(meta.deal_image);
if (dealImageId) {
  await linkMedia(dealImageId, entityId, "api::deal.deal", "dealImage");
} else {
  const imageId = await resolveMediaRef(meta.image);
  if (imageId) {
    await linkMedia(imageId, entityId, "api::deal.deal", "dealImage");
  }
}
```
Try `deal_image` first, fall back to the generic `image` meta. The field is always `"dealImage"` regardless of source — that's the Strapi schema field name.

`getDealLinkTable` (lines 333–343):
```ts
stores:     { table: "deals_stores_lnk",     dealCol: "deal_id", termCol: "store_id" }
brands:     { table: "deals_brands_lnk",     dealCol: "deal_id", termCol: "brand_id" }
categories: { table: "deals_categories_lnk", dealCol: "deal_id", termCol: "category_id" }
banks:      { table: "deals_banks_lnk",      dealCol: "deal_id", termCol: "bank_id" }
```

### 6k. Phase 09 — SEO Backfill (`09-seo-backfill.ts`)

Fills in missing SEO components on the four taxonomy tables. Phase 03 already inserts SEO components when term-level Yoast meta exists; this phase catches terms that have SEO in `wp_yoast_indexable` (Yoast's newer denormalized table) but not in `wp_termmeta`.

For each of `stores`, `brands`, `categories`, `banks`:

1. **Find entities that already have SEO** (lines 18–22):
   ```sql
   SELECT entity_id FROM "${table}_cmps"
   WHERE field = 'seo' AND component_type = 'shared.seo'
   ```

2. **Find entities that need SEO**:
   ```sql
   SELECT id, "name" FROM "${table}"
   ```
   Filter in JS against the has-SEO set.

3. **Fetch Yoast data** (lines 38–47):
   ```sql
   SELECT object_id, title, description
   FROM wp_yoast_indexable
   WHERE object_type = 'term'
   AND object_sub_type = 'category'
   ```
   `object_id` is the WP `term_id`.

4. **For each entity-needing-SEO**, look up the original WP term_id via `getAllTermMappings()` (scanning the id map for a matching `{id, table}`), then lookup the Yoast row and insert via `insertComponent`:
   ```ts
   await insertComponent(
     "components_shared_seos",
     {
       meta_title: resolveYoastVariables(yoast.title, entity.name) || null,
       meta_description: yoast.description || null,
       canonical_url: null,
     },
     table, entity.id, "seo", "shared.seo"
   );
   ```

Fails soft: if `wp_yoast_indexable` doesn't exist, the whole table loop just logs a warning and continues.

### 6l. Phase 10 — Verify (`10-verify.ts`)

Always runs (`skipCheckpoint: true`). Never throws — every check logs. The purpose is to give you a sanity report, not gate the run.

#### Count checks (lines 21–106)

Each produces a `CountCheck { entity, wpCount, pgCount, match }`.

**Stores**:
```sql
SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Store'
SELECT COUNT(*) AS c FROM stores
```

**Brands**:
```sql
SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Brand'
SELECT COUNT(*) AS c FROM brands
```

**Categories**:
```sql
SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Category'
SELECT COUNT(*) AS c FROM categories
```

**Banks**:
```sql
SELECT COUNT(*) AS c FROM wp_termmeta WHERE meta_key = 'choose_type' AND meta_value = 'Bank'
SELECT COUNT(*) AS c FROM banks
```

**Coupons** (non-deals, include future/scheduled):
```sql
SELECT COUNT(*) AS c FROM wp_posts p
WHERE p.post_type = 'post' AND p.post_status IN ('publish', 'future')
AND p.ID NOT IN (
  SELECT post_id FROM wp_postmeta WHERE meta_key = 'is_deal' AND meta_value = 'yes'
)

SELECT COUNT(*) AS c FROM coupons
```

**Deals**:
```sql
SELECT COUNT(*) AS c FROM wp_posts p
JOIN wp_postmeta pm ON p.ID = pm.post_id AND pm.meta_key = 'is_deal' AND pm.meta_value = 'yes'
WHERE p.post_type = 'post' AND p.post_status IN ('publish', 'future')

SELECT COUNT(*) AS c FROM deals
```

**Pools** (optional, wrapped in try/catch):
```sql
SELECT COUNT(*) AS c FROM wp_uc_coupons
SELECT COUNT(*) AS c FROM unique_coupon_pools
```

**Codes** (optional):
```sql
SELECT COUNT(*) AS c FROM wp_uc_codes
SELECT COUNT(*) AS c FROM unique_codes
```

**Users**:
```sql
SELECT COUNT(DISTINCT post_author) AS c FROM wp_posts
WHERE post_type = 'post' AND post_status IN ('publish', 'future')

SELECT COUNT(*) AS c FROM admin_users WHERE document_id LIKE 'wp\_%' ESCAPE '\'
```

The `LIKE 'wp\_%' ESCAPE '\'` scopes the count to migrated users only.

Each check logs `✓ Entity: WP=N PG=N [PASS]` or `✗ ... [FAIL]`.

#### User/creator sanity (lines 120–144)

**Migrated users missing Editor role**:
```sql
SELECT COUNT(*) AS c
FROM admin_users u
LEFT JOIN admin_users_roles_lnk l ON l.user_id = u.id
LEFT JOIN admin_roles r ON r.id = l.role_id
WHERE u.document_id LIKE 'wp\_%' ESCAPE '\'
  AND (r.code IS NULL OR r.code <> 'strapi-editor')
```

**Coupons with NULL created_by**:
```sql
SELECT COUNT(*) AS c FROM coupons WHERE document_id LIKE 'wp\_%' ESCAPE '\' AND created_by_id IS NULL
```

**Deals with NULL created_by**:
```sql
SELECT COUNT(*) AS c FROM deals WHERE document_id LIKE 'wp\_%' ESCAPE '\' AND created_by_id IS NULL
```

Non-zero is flagged but not failed — legit reasons include skipped authors (missing email).

#### Relationship integrity (lines 150–171)

**Orphan coupons** (no taxonomy at all):
```sql
SELECT COUNT(*) AS c FROM coupons c
WHERE NOT EXISTS (SELECT 1 FROM coupons_stores_lnk WHERE coupon_id = c.id)
AND NOT EXISTS (SELECT 1 FROM coupons_brands_lnk WHERE coupon_id = c.id)
AND NOT EXISTS (SELECT 1 FROM coupons_categories_lnk WHERE coupon_id = c.id)
AND NOT EXISTS (SELECT 1 FROM coupons_banks_lnk WHERE coupon_id = c.id)
```

**Orphan deals**:
```sql
SELECT COUNT(*) AS c FROM deals d
WHERE NOT EXISTS (SELECT 1 FROM deals_stores_lnk WHERE deal_id = d.id)
AND NOT EXISTS (SELECT 1 FROM deals_brands_lnk WHERE deal_id = d.id)
AND NOT EXISTS (SELECT 1 FROM deals_categories_lnk WHERE deal_id = d.id)
AND NOT EXISTS (SELECT 1 FROM deals_banks_lnk WHERE deal_id = d.id)
```

#### Slug uniqueness (lines 175–184)

For each taxonomy:
```sql
SELECT COUNT(*) AS c FROM (
  SELECT slug, COUNT(*) AS cnt FROM "${table}" GROUP BY slug HAVING COUNT(*) > 1
) AS dupes
```

Expected to be zero given `deduplicateSlug`.

#### SEO coverage (lines 188–196)

For each of stores/brands/categories/banks:
```sql
SELECT COUNT(*) AS c FROM "${table}"
SELECT COUNT(DISTINCT entity_id) AS c FROM "${table}_cmps"
WHERE field = 'seo' AND component_type = 'shared.seo'
```

Logs percentage. No target threshold — just a number to eyeball.

#### Spot checks (lines 201–221)

```sql
SELECT name, slug FROM stores ORDER BY RANDOM() LIMIT 5
SELECT title, code, coupon_type FROM coupons ORDER BY RANDOM() LIMIT 5
```

`ORDER BY RANDOM()` is fine here because the tables aren't huge and it only runs once per migration.

### 6m. Phase 11 — Copy Used Media (`11-copy-used-media.ts`)

Only matters when phase 02 used the *local* provider (no S3 config). Copies the referenced files into Strapi's `public/uploads` so Strapi can serve them.

```sql
SELECT DISTINCT f.id, f.url, f.provider, f.provider_metadata
FROM files f
JOIN files_related_mph fmph ON f.id = fmph.file_id
WHERE f.provider = 'local'
```

The `JOIN` on `files_related_mph` filters out unused files — only things actually linked to some entity get copied.

Per file:
- Parse `provider_metadata` (possibly already an object if pg auto-parsed jsonb): `meta.sourcePath`.
- If the source doesn't exist on disk → count as `failed`.
- Target filename from `path.basename(file.url)` (e.g. `/uploads/abc123_image.jpg` → `abc123_image.jpg`).
- If target exists → `skipped`.
- Otherwise `fs.copyFileSync(sourcePath, targetPath)`, count as `copied`.

Logs `copied=N, skipped=N, failed=N`.

### 6n. Phases 12–15 — Backfills (compact reference)

These trailing phases run against already-migrated rows rather than reading fresh WordPress data. They post-date this document's line-by-line style, so they are summarized here; `migration/README.md` carries the authoritative per-phase prose.

- **Phase 12 — Offer Backfill (`12-offer-backfill.ts`).** Fills the `deal.primaryStore` manyToOne from the ACF `deal_store` postmeta (a store term id, plain or PHP-serialized). Writes to the link table discovered at runtime via `information_schema` (expected `deals_primary_store_lnk`) with delete-then-insert semantics so re-runs never leave stale rows. Only posts present in the persisted id maps are touched; a missing link table (schema not migrated) logs a warning and skips.

- **Phase 13 — Site Content (`13-site-content.ts`).** Seeds the four frontend single types — `global`, `homepage`, `menu`, `footer` (all publish-only; draftAndPublish disabled). Curated sections are built from migrated entities and ACF option keys; per-section item counts live in `src/utils/homepage-limits.ts` (each carries a +4 buffer over what the site renders, pinned to the component schema `max` by a parity test). Every component/relation link-table name is verified against `information_schema` first; each single type is skipped when its table already has a row, so re-runs are safe.

- **Phase 13a — Homepage Coupon Offer Sections (`13a-homepage-offer-sections.ts`).** Backfills the Coupon-backed `exploreOffers`/`offersByBrand` component trees onto homepages created before those components existed, preserving the legacy section/category/brand criteria. Idempotent (populated sections are skipped), transactional, and serialized on the homepage row. Missing component/relation infrastructure fails the phase (not checkpointed) — apply the Strapi schemas first and rerun. Run standalone after deploying the new schemas: `npm run migrate -- --phase 13a-homepage-offer-sections`.

- **Phase 14 — Media Optimize (`14-media-optimize.ts`).** Two passes over already-migrated S3 images. Pass 1 (candidates: `provider='aws-s3'`, `formats IS NULL`, optimizable MIME) optimizes the original + generates the full variant matrix incl. AVIF twins, writing `formats`/`ext`/`mime`/`url`/dims/`provider_metadata` in a single `UPDATE` as the last step; superseded objects are deleted on key change unless `--keep-originals`. Pass 2 (rows with `formats` but no `original_avif`) adds AVIF twins (`original_avif`/`xsmall_avif`/`small_avif`/`medium_avif`/`large_avif`) and merges them with `formats = formats || $new`. Source bytes resolve from a local `WP_UPLOADS_DIR` hash map, then the S3 object.

- **Phase 15 — Media Formats Backfill (`15-media-formats-backfill.ts`).** Fills variant-matrix gaps for rows that **already have** `formats` (e.g. migrated before the `xsmall`/thumbnail rungs existed) — the gap Phase 14 cannot close. Per row it computes `expectedFormatKeys() − stored keys`, generates only the missing variants from the current S3 master (local WP original as the AVIF source when available), and jsonb-merges them last. `--dry-run` (DB-only report), `--limit N`, `--overwrite` (regenerate all, unconditional puts). Variant puts are conditional (`IfNoneMatch: "*"`; 412 = already present; `NotImplemented` flips to unconditional). S3 master key resolves `provider_metadata.key` → `{rootPath}/{hash}{ext}` → legacy `{rootPath}/{hash}_{name}{ext}`. Shared-hash rows serialize and reuse generated entries but each merges its own missing set. Never checkpointed (`skipCheckpoint: true`) so it stays re-runnable.

---

## 7. Relationship Wiring — Deep Dive

Strapi v5 relationships live in two kinds of tables:

### 7a. M2M link tables

Naming: `{ownerTable}_{fieldName}_lnk`. Columns: `{owner_singular}_id`, `{target_singular}_id`, and one or two `_ord` columns for UI ordering.

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

Ordering rules:
- `_ord` increments *per-owner* (so a coupon's stores are ordered 1, 2, 3 independent of its brands).
- Primary taxonomy (from `wp_yoast_primary_term`) is inserted first, so it gets `ord = 1`.

All link inserts go through `insertLink(table, columns)` which appends `ON CONFLICT DO NOTHING` — so re-running any content phase never creates duplicate rows.

Note: `deals_display_store_lnk` was removed. The `deal_store` postmeta is now merged into `deals_stores_lnk` with per-table dedup (see §6j).

### 7b. Polymorphic media — `files_related_mph`

One table for all media links:

| Column | Meaning |
|---|---|
| `file_id` | `files.id` |
| `related_id` | The owner entity's PG id |
| `related_type` | Strapi UID (e.g. `"api::coupon.coupon"`) |
| `field` | Schema field name (e.g. `"image"`, `"logo"`, `"icon"`, `"dealImage"`) |
| `order` | UI ordering (always 1 in our migration) |

Unique index (created in phase 00):
```sql
CREATE UNIQUE INDEX "files_related_mph_uq"
ON "files_related_mph" ("file_id", "related_id", "related_type", "field");
```

Used field names across the migration:
- `"logo"` — stores, brands, banks (phase 03)
- `"icon"` — categories (phase 03)
- `"image"` — coupons, and the fallback for deals (phase 07–08)
- `"dealImage"` — deals primary (phase 08)

### 7c. Components — `{entity}_cmps`

Strapi v5 keeps component data in two tables: the data table (`components_shared_seos`, `components_shared_faq_items`) and the join table `{entity}_cmps`:

| Column | Meaning |
|---|---|
| `entity_id` | The owner entity's PG id |
| `cmp_id` | Component row id in the data table |
| `component_type` | `"shared.seo"` or `"shared.faq-item"` |
| `field` | Schema field name (`"seo"`, `"faqs"`) |
| `order` | Order within the field (1 for single components, n+1 for repeatables) |

`insertComponent` (§5b) pre-checks this table to avoid duplicates across re-runs.

### 7d. Primary taxonomy term

Yoast stores one "primary category" per post in `wp_yoast_primary_term`. Both coupon and deal phases fetch it via `getPrimaryTerms`. Whichever term is primary gets inserted first in `wireCouponRelations` / `linkTerm`, so it lands with `_ord = 1`.

Strapi doesn't enforce a "primary" concept, but the admin UI will render the first-ordered row as the default, so the ordering carries meaning.

---

## 8. Media Filtering & Resolution — Deep Dive

### 8a. Inventory-time filter (phase 01)

Two hard filters on what gets inventoried:

1. **Mime type**: only `image/*`. Non-images don't exist in the Strapi schema's media fields.
2. **Plugin subdir blacklist**: the first path segment of the relative GUID path is checked against `SKIP_DIRS`. Plugin artifacts, backups, popup assets, migration-tool dumps, etc. are dropped.

Nothing is written to disk or the DB yet — it's all in memory.

### 8b. On-demand upload (phase 02)

Uploads only happen when a content phase actually references an attachment id. This has two big benefits:

1. **No wasted uploads** of attachments that are no longer referenced. A WP media library with 50,000 items where only 8,000 are actually used won't waste bandwidth on the other 42,000.
2. **Clean error surface**: when an upload fails, we know exactly which content row needed it.

### 8c. Dedup by SHA-256

Every upload computes `sha256(file content).hex.slice(0, 16)` and checks it against the `files.hash` column. Same image bytes uploaded under two different WP attachment IDs → single Strapi `files` row, two `mediaIdMap` entries pointing at the same id.

The `files_hash_uq` partial unique index (phase 00):
```sql
CREATE UNIQUE INDEX "files_hash_uq" ON "files" ("hash") WHERE "hash" IS NOT NULL;
```
ensures dedup is enforced at the DB level too.

### 8d. Morph linking

Every media reference ends up as one row in `files_related_mph`:
- Phase 03: `(fileId, termEntityId, strapiType, "logo"|"icon")`
- Phase 07: `(fileId, couponId, "api::coupon.coupon", "image")`
- Phase 08: `(fileId, dealId, "api::deal.deal", "dealImage")`

### 8e. Orphan-safe

If `resolveMediaRef` returns `undefined` (missing local file, non-image, URL instead of id, …), the caller just skips the link. No throw, no retry, debug log. The entity still gets inserted without media.

---

## 9. Connection Lifecycle

### 9a. Startup

- First call to `getWpPool()` → `createSSHTunnel()` (if configured) → `mysql.createPool(…)`. Tunnel port is determined at runtime; MySQL pool connects via `127.0.0.1:<tunnelPort>`.
- First call to `getPgPool()` → `buildSslConfig()` (reads the CA cert from disk if configured) → `new Pool(…)`.

Both are lazy. A `--phase 10-verify` run with phase 10 being pure-read only opens the pools when the first query fires, not at script start.

### 9b. Shutdown

The `finally` block in `main()` always runs:
```ts
await closeWp();
await closePg();
```

`closeWp()` (lines 106–119):
```ts
if (pool) { await pool.end(); pool = null; }
if (localServer) { localServer.close(); localServer = null; }
if (sshClient) { sshClient.end(); sshClient = null; }
```

Order matters: end the MySQL pool first (closes all pooled connections that are piping through the tunnel), then close the local server, then end the SSH client.

### 9c. Per-phase resource usage

- MySQL: read-only, parameterized. No transactions needed on this side.
- Postgres: mostly single-statement inserts/updates. No explicit transactions — every SQL call is its own autocommit. The idempotency mechanism (`ON CONFLICT DO NOTHING` + deterministic document_id) makes this safe even if the process dies mid-phase.

---

## 10. Idempotency Summary

Three layers stack:

1. **Deterministic document_id** — `wp_<sha256 prefix>` based on a source key unique per WP row. `ON CONFLICT ("document_id") DO NOTHING` ensures re-inserts are no-ops.
2. **Phase checkpoints** — `.checkpoints/<phase>.json` marks completion. A normal re-run skips completed phases.
3. **Persisted id maps** — `.checkpoints/*Map.json` means phase 08 can run standalone against a database that was populated by a *different* process that ran phases 03–06a.

`--clean` is the opposite direction: wipe all three layers plus Strapi's migration-created rows plus S3, ready for a fresh run.

`--phase <name>` is the surgical option: run exactly one phase, whether it was previously complete or not.

---

## 11. Verification Playbook

Run:
```bash
yarn migrate --phase 10-verify
```

Read the output sections:

### Record Count Verification
Every entity should `[PASS]`. Common gotchas:
- `Users: WP=N PG=M` where M < N — `skippedNoEmail` in the 06a logs explains the gap.
- `Coupons` mismatch — an uncategorized post may have hit the `DO NOTHING` path; grep `migration-errors.log` for the post id.
- `Codes` far less than WP — pool mapping missed; likely phase 05 was skipped but phase 06 ran.

### Users & Creator Backfill
- `Migrated users missing Editor role: 0` expected.
- `Coupons / Deals with NULL created_by: N` — non-zero is OK if `N ≤ skippedNoEmail`.

### Relationship Integrity
- `Coupons / Deals without taxonomy: 0` expected. Non-zero means one of:
  - The post had no WP category at all.
  - All its category terms had unrecognized `choose_type` and fell into the default `Store` bucket under a unique id that doesn't match.

### Slug Uniqueness
Should always be 0. Non-zero means `deduplicateSlug` missed something (likely a race if phase 03 was run multiple times across processes — a single-process run uses the in-memory tracker correctly).

### SEO Components
Coverage percentage — nothing to action, just informational.

### Spot Checks
Eyeball 5 random stores and 5 coupons. Names should look right; coupon codes should be present on `coupon_type='unique'` rows (deals rarely have codes).

---

## 12. Runbook

Setup and CLI flags are documented in `migration/README.md`. This section is "what to do when something fails."

### "admin_roles 'strapi-editor' not found"
Thrown by phase 06a. Fix: start Strapi once (`yarn develop` in the repo root) so default roles get seeded, then re-run `yarn migrate --phase 06a-users`.

### "PG CA cert not found at …"
Thrown by `pg-client.ts:17`. Fix: either remove `PG_CA_CERT_PATH` (if the target doesn't need SSL) or make sure the file exists at the absolute path shown in the error.

### "wp_uc_coupons table not found. Skipping pools migration."
Expected if the Unique Coupons plugin isn't installed. Phases 05 and 06 become no-ops.

### "wp_yoast_primary_term not available"
Expected if Yoast isn't installed. Primary-term ordering falls back to WP's natural order from `wp_term_relationships`.

### "Batch N failed: ..."
In phase 06. The batch offsets don't move back, so re-running the phase with `--phase 06-codes` will re-attempt from the first unsatisfied offset. Because of `ON CONFLICT DO NOTHING`, already-inserted codes are no-ops.

### "S3 PutObjectCommand failed"
Phase 02 on-demand upload. The calling content phase's row still inserts (the media ref just comes back `undefined`). Fix credentials or bucket, then re-run the owning phase with `--phase 07-coupons` (or 08) — it'll reach the dedup cache for previously-uploaded rows and re-try the failed ones.

### Partial progress after a crash
Just re-run `yarn migrate`. The checkpoint system picks up where it left off. If you suspect corrupted state, `yarn migrate --clean` and start fresh.
