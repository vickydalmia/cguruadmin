# Search Operations

Operator reference for `/api/search`: how a process picks its execution mode,
which indexes it expects, how to inspect it, and how Strapi automatically
repairs indexes whose migration DDL was skipped. For the request/response contract the frontend codes
against, see [public-api.md](./public-api.md).

Source of truth:
[`src/api/search/services/search.ts`](../src/api/search/services/search.ts)
(mode selection, index diagnostics),
[`src/api/search/services/search-sql.ts`](../src/api/search/services/search-sql.ts)
(the ranked query builders),
[`src/policies/search-status-auth.ts`](../src/policies/search-status-auth.ts)
(the status endpoint's guard),
[`database/search-index-migration.js`](../database/search-index-migration.js)
(the migration and post-schema-sync DDL helper).

## Two execution modes, fixed per process

| Mode | When | Behaviour |
|---|---|---|
| `postgres-sql` | the configured database dialect is PostgreSQL | Full-set ranked SQL: WHERE + tier `ORDER BY` + `LIMIT`/`OFFSET` executed by Postgres over the entire matching set |
| `query-engine` | any non-Postgres dialect | Strapi query-engine reads plus the JS scorer, ranking and paging the full matching set in the application |

**The dialect is the only selector.** Strapi's `bootstrap` fixes the mode
before the instance serves traffic and never changes it; the request path never
probes capabilities. `pg_trgm` and its indexes are observed separately and are
**performance aids only** — they change neither which rows match nor their
order, so a database missing them still serves correct results, just slower.

Once bootstrap has selected `postgres-sql`, a SQL failure at request time is
returned as a real error rather than silently falling back. Serving one page
from a different scorer than its neighbours would reorder results
mid-pagination, which is exactly what the fixed mode exists to prevent.

Practical consequence for operators: because mode follows the dialect alone,
you cannot accidentally boot into the slow path on a Postgres deploy. What you
*can* boot into is Postgres mode with missing or malformed indexes — that is
what the diagnostics below are for.

### Ordering

Both scorers use the same tiers: literal direct-field matches in tiers 0–3,
derived singular/plural variants in 4–7, relation-name matches in 8–15, and
slug-only matches at tier 99. Coupon `code` is a direct field. ASCII `A-Z` is
folded to `a-z`; non-ASCII characters remain exact-case, avoiding differences
between PostgreSQL locales and JavaScript Unicode lowercasing. Ties break on
that ASCII-folded label, then `documentId`. PostgreSQL compares under the
stable bytewise `C` collation and the JavaScript path mirrors that ordering.

No ordering path calls a `pg_trgm` function. The fallback reads visible rows in
deterministic 500-row batches and does literal membership testing in
JavaScript, so `%`, `_` and backslash are ordinary query characters there
rather than LIKE metacharacters.

## Expected indexes

`EXPECTED_SEARCH_INDEX_DEFINITIONS` in
[`src/api/search/services/search.ts`](../src/api/search/services/search.ts)
declares **11** trigram GIN indexes, each as a `{ name, table, column }` triple
so the runtime can verify the definition and not merely the name. All are
`USING gin (translate(<column>, 'A…Z', 'a…z') gin_trgm_ops)` — expression
indexes on the same deterministic ASCII fold used by every semantic
`translate(col, 'A…Z', 'a…z') LIKE ?` probe.

| Index | Backs |
|---|---|
| `stores_name_search_trgm_idx` | ASCII-folded `name LIKE '%needle%'` on stores — both the Store group's own WHERE and the relation `EXISTS` subqueries that let a coupon/deal match on its store's name |
| `brands_name_search_trgm_idx` | same, brands |
| `categories_name_search_trgm_idx` | same, categories |
| `banks_name_search_trgm_idx` | same, banks |
| `coupons_title_search_trgm_idx` | ASCII-folded title containment — the Coupon group's direct match column |
| `deals_title_search_trgm_idx` | same, deals |
| `stores_slug_search_trgm_idx` | ASCII-folded slug prefix probes on stores, directly and inside relation `EXISTS` subqueries. Strapi's unique raw-slug index cannot serve the `translate()` expression |
| `brands_slug_search_trgm_idx` | same, brands |
| `categories_slug_search_trgm_idx` | same, categories |
| `banks_slug_search_trgm_idx` | same, banks |
| `coupons_code_search_trgm_idx` | ASCII-folded coupon-code containment, which has no other expression index |

No link-table indexes are needed: Strapi 5 already creates a `_fk` index on the
owner column of every `_lnk` table, which covers the `coupon_id` / `deal_id`
side of the relation `EXISTS` probes.

### Present, but wrong

`CREATE INDEX IF NOT EXISTS` accepts **any** index with the right name, even one
built on the wrong table, expression, access method or operator class. Bootstrap
therefore validates each expected index against the catalog and reports the
defective ones separately from the absent ones. An index is called invalid when
any of these does not hold:

- it belongs to the expected table in the resolved Strapi schema (the runtime
  uses configured schema-qualified `to_regclass` lookups, not `current_schema()`);
- its access method is GIN;
- it has exactly one indexed expression, and that expression canonicalizes to
  `translate(<column>, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`
  (whitespace, identifier quotes and `::text` / `::character varying` casts
  normalized away);
- its operator class is `gin_trgm_ops` **from the schema that actually owns
  `pg_trgm`** — the extension may be installed outside the application's
  `search_path`, and an operator class from elsewhere is not the one the
  planner will use;
- it is not partial;
- it is both `indisvalid` and `indisready`.

Each failure is reported with a human-readable reason, so the log or status
payload tells you *why* an index does not count.

## Inspecting a running instance

`GET /api/search/status`:

```json
{
  "mode": "postgres-sql",
  "pgTrgmAvailable": true,
  "missingExpectedIndexes": [],
  "invalidExpectedIndexes": [{ "name": "stores_slug_search_trgm_idx", "reason": "access method is not GIN" }]
}
```

**Auth posture: machine-only.** The route is `auth: false` but carries the
`global::search-status-auth` policy, which requires
`Authorization: Bearer $ISR_ADMIN_SECRET` — the same admin secret as ISR
revalidation — compared in constant time against the exact expected string. It
**fails closed**: if `ISR_ADMIN_SECRET` is unset or empty the policy denies
every request and logs that the secret is not configured. A missing header, a
wrong value, a lowercase `bearer`, or trailing content all fail. The route is
deliberately returned with `Cache-Control: private, no-store`, so what you read
is the live runtime status, not a shared or 30-second-old cached copy.

```bash
curl -H "Authorization: Bearer $ISR_ADMIN_SECRET" \
  http://127.0.0.1:1337/api/search/status
```

In production the endpoint is not reachable from the public internet at all:
nginx returns 403 for `/api/` on the CMS hostname.

### Boot logs

A clean boot logs:

```
[search] mode=postgres-sql pg_trgm=available missing_indexes=0 invalid_indexes=0
```

A non-Postgres process logs `[search] mode=query-engine` and skips index
inspection entirely. If `pg_trgm` is absent, or any expected index is missing or
invalid, one consolidated line is logged at **error** level in production (warn
elsewhere) naming each missing index and each invalid index with its reason,
and stating that automatic reconciliation retries on the next boot. Search stays in `postgres-sql` mode
regardless — these are performance diagnostics, not a downgrade trigger.

## Boot-time index DDL and why it can be skipped

Two migrations — `2026.07.12T01.00.00.add-public-search-indexes.js` (name/title)
and `2026.07.19T00.00.00.add-search-rank-indexes.js` (slug/code, and a
re-reconcile of all 11) — create these indexes through the shared helper in
[`database/search-index-migration.js`](../database/search-index-migration.js).
Both are **best-effort**: a locked-down database role must not block Strapi
boot, because search works without them.

The helper's guarantees:

- **Nested savepoints.** Each optional `CREATE EXTENSION` or index repair runs
  inside its own `SAVEPOINT`, rolled back and released on failure. PostgreSQL
  marks the whole transaction aborted after any DDL error, so recovering the
  savepoint first is what lets the migration continue at all. A malformed
  same-name index is dropped and recreated in one savepoint, so failure to
  create the replacement rolls the drop back too.
- **Classified failures.** Insufficient privilege, lock-not-available, deadlock
  and statement-timeout — plus, for the extension, "not available" / missing
  control file, and for an index, a `gin_trgm_ops does not exist for access
  method gin` error — are treated as *expected optional* failures: warn and
  end that reconciliation pass so startup cannot accumulate one bounded wait
  per index. The next boot retries. Any other migration error still fails, so
  a real schema defect is not swallowed; bootstrap logs unexpected failures
  without making the process unavailable.
- **Bounded waits.** `SET LOCAL lock_timeout = '5s'` and
  `statement_timeout = '30s'` are applied per migration transaction, so optional
  DDL cannot hold startup behind another transaction indefinitely.
- **Transaction-safe DDL.** Reconciliation uses `CREATE INDEX`, not
  `CREATE INDEX CONCURRENTLY`, because Strapi user migrations are transactional.
- **Structural repair.** Before accepting `IF NOT EXISTS`, the helper checks
  table, expression, GIN access method, extension-owned `gin_trgm_ops`, partial
  predicate, and valid/ready state. A wrong same-name index is replaced.
- **Schema-qualified operator class.** The healthy path reads `pg_extension`
  first and issues no extension DDL. Only when `pg_trgm` is absent does it try
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`, then re-read the catalog to discover
  which schema owns it. Index DDL emits the ASCII-folded
  `translate(col, 'A…Z', 'a…z')
  `<schema>.gin_trgm_ops`. If the schema cannot
  be discovered it warns and skips the indexes rather than creating ones the
  runtime would then classify as invalid. This is what makes an extension
  installed outside `search_path` usable.

### The fresh-database trap

Strapi 5 runs `database/migrations` **before** schema sync creates the content
tables. On a completely fresh database the DDL therefore arrives when `stores`,
`coupons` and friends do not exist yet, and an unguarded `CREATE INDEX` would
abort boot with `42P01`. The migration therefore skips absent tables and logs
one consolidated warning. After schema sync, Strapi bootstrap invokes the same
helper again before search runtime diagnostics. That retry creates the indexes
on a fresh database automatically.

The post-schema-sync reconciliation runs on every PostgreSQL boot. Healthy
indexes require catalog reads only. Missing indexes are created; malformed or
invalid same-name indexes are atomically replaced. Concurrent instances
use the same transaction advisory lock as both migrations; when another
instance owns it, this pass skips immediately instead of delaying startup.
Permission, extension, lock, and timeout failures are loud but non-fatal:
search stays correct, status reports the performance gap, and the next boot
retries automatically. A clean `GET /api/search/status` response with both
index arrays empty is the authoritative verification.

## Symptoms and first moves

| Symptom | Likely cause | Move |
|---|---|---|
| `status` reports `mode: query-engine` on what should be a Postgres deploy | the process is not connected to Postgres at all — check `DATABASE_CLIENT` / connection config | Fix the database configuration and redeploy |
| `status` lists `missingExpectedIndexes`, search feels slow | automatic DDL hit a permission, extension, lock, or timeout failure | Read the loud boot log; fix the application role/database provisioning if needed, then restart so automatic reconciliation retries |
| `status` lists `invalidExpectedIndexes` | the automatic replacement hit a bounded DDL failure | Read the boot log and restart after resolving the reported permission/lock problem |
| `pgTrgmAvailable: false` | the extension is not installed, cannot be created by the application role, or the catalog could not be read | Enable `pg_trgm` through normal database provisioning or grant the application role the capability, then restart |
| Missing indexes right after provisioning a new database | post-schema-sync reconciliation could not complete | Read the boot log; the next boot retries automatically |
| `/api/search/status` returns 401/403 from your shell | the policy failed closed — secret unset, or the header is not an exact `Bearer <secret>` | Check `ISR_ADMIN_SECRET` on the container; note the endpoint is also nginx-blocked on the public CMS host |
| Search results correct but latency high under load | indexes fine, caches cold | `/api/search` has a 30s in-process cache and the gateway layers its own — see [strapi-production-deployment.md](./strapi-production-deployment.md#search-cache-and-index-semantics) |
| Search 500s after a deploy | ranked SQL failing post-bootstrap (never silently downgraded) | Read the `search: Postgres SQL failed` error log; schema drift on the offer/link tables is the usual cause |
