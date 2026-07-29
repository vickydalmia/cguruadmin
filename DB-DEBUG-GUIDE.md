# Database Debug Guide

Practical SQL for debugging this project's PostgreSQL. Written for TablePlus / psql against the DigitalOcean managed instance.

**This database:** DO managed PostgreSQL 18, **1 GB RAM / 1 vCPU**, **22 backend connection limit**. It is small — most "the site is slow" answers live here.

**Which connection to use:** always connect **direct** (not the PgBouncer pool) for debugging. Diagnostics rely on session state, and through a transaction-mode pooler you land on a random backend. Pool credentials are for the app only.

---

## 1. What is happening RIGHT NOW

The first query to run when something is slow. Shows every live query, longest first.

```sql
SELECT
  pid,
  round(EXTRACT(epoch FROM (now() - query_start))::numeric, 1) AS running_sec,
  state,
  wait_event_type,
  wait_event,
  left(query, 120) AS query
FROM pg_stat_activity
WHERE state <> 'idle'
  AND query NOT ILIKE '%pg_stat_activity%'
ORDER BY running_sec DESC;
```

**How to read it:**

| Signal | Meaning |
|---|---|
| `running_sec` > 5 on several rows | Real trouble — usually a render storm or a missing index |
| `wait_event_type = 'Lock'` | Blocked by another transaction → go to §5 |
| `wait_event_type = 'IO'` | Reading from disk — working set exceeds the 1 GB cache |
| `state = 'idle in transaction'` | **Bad.** A transaction left open, holding locks and a connection |
| Many rows, all fast | Not a query problem — it's volume (§3) |

### Idle-in-transaction hunt

These hold connections and block VACUUM. Anything over a minute is a bug.

```sql
SELECT pid, state,
       round(EXTRACT(epoch FROM (now() - state_change))::numeric) AS idle_sec,
       left(query, 100) AS last_query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY idle_sec DESC;
```

---

## 2. Stopping a runaway query

```sql
SELECT pg_cancel_backend(<pid>);      -- polite: cancels the query, keeps the connection
SELECT pg_terminate_backend(<pid>);   -- forceful: kills the whole connection
```

Always try `pg_cancel_backend` first. Use `terminate` for `idle in transaction` sessions, which have no query to cancel.

---

## 3. Worst queries over time (the money query)

`pg_stat_statements` aggregates every query since the last reset. This is how you find where database time actually goes.

```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;   -- one time only
```

```sql
SELECT
  round(mean_exec_time)::int          AS avg_ms,
  round(max_exec_time)::int           AS max_ms,
  calls,
  round(total_exec_time/1000)::int    AS total_sec,
  query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

**Sort by `total_sec`, not `avg_ms`.** A 9 ms query called a million times costs far more than a 5-second query called twice. Both problems exist here, and they need opposite fixes:

- **High `avg_ms`, low `calls`** → the query is bad. Fix with an index or a rewrite (§7, §8).
- **Low `avg_ms`, huge `calls`** → N+1 from the render pipeline. Fix by caching or trimming populate, not by touching SQL.

### Measuring a specific activity

Stats are cumulative and hide recent changes behind months of history. To measure one thing cleanly:

```sql
SELECT pg_stat_statements_reset();
```

Then do the thing (publish an entity, run searches, load pages), wait a minute, and re-run the query above. Now you're looking only at that activity.

⚠️ Reset destroys history. Save the old output first if it matters.

---

## 4. Connections and the 22 limit

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE state = 'active')              AS active,
       count(*) FILTER (WHERE state = 'idle')                AS idle,
       count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn
FROM pg_stat_activity;
```

Budget for this project — each Strapi container's `DATABASE_POOL_MAX` counts separately:

| Setup | Expected max |
|---|---|
| One Strapi container | 10 |
| Two containers @ `DATABASE_POOL_MAX=5` | 10 |
| Two containers + search service | 15 |

Anything approaching 22 means something is leaking connections. `remaining connection slots are reserved` in the app logs is the symptom.

### Where connections come from

```sql
SELECT client_addr, count(*)
FROM pg_stat_activity
GROUP BY client_addr
ORDER BY count DESC;
```

Connections through the PgBouncer pool appear from an internal/loopback address; direct connections show the droplet's IP.

---

## 5. Locks and blocking

When queries hang with `wait_event_type = 'Lock'`, this shows who blocks whom:

```sql
SELECT
  blocked.pid          AS blocked_pid,
  blocking.pid         AS blocking_pid,
  left(blocked.query, 80)  AS blocked_query,
  left(blocking.query, 80) AS blocking_query,
  blocking.state       AS blocking_state
FROM pg_stat_activity blocked
JOIN pg_stat_activity blocking
  ON blocking.pid = ANY(pg_blocking_pids(blocked.pid))
WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0;
```

Relevant here because two code paths take row locks deliberately: unique-coupon redemption (`SELECT … FOR UPDATE`) and the write-serialization advisory locks. If `blocking_state` is `idle in transaction`, the blocker is a bug — terminate it.

---

## 6. Configuration checks

```sql
-- JIT (was a real incident: added ~17s to complex queries). Should be off.
SELECT name, setting, source FROM pg_settings WHERE name LIKE 'jit%';

-- Statement timeout: bounds runaway queries
SHOW statement_timeout;

-- Per-database overrides
SELECT d.datname, s.setconfig
FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase;
```

The `source` column matters: `database` or `configuration file` means every connection inherits it; `session` means only yours.

Changing a database-level setting requires a **reconnect** to see it, and a **Strapi restart** for the app to pick it up.

```sql
ALTER DATABASE defaultdb SET jit = off;
ALTER ROLE <app_role> SET statement_timeout = '10s';
```

---

## 7. Explaining a slow query

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
<paste the query with real values>;
```

⚠️ `ANALYZE` actually executes the query. Never run it on an `INSERT`/`UPDATE`/`DELETE` outside a transaction you roll back.

**What to look for:**

| In the plan | Means |
|---|---|
| `Seq Scan` on a large table | Missing index, or statistics are stale → run `ANALYZE <table>` |
| Estimated rows wildly ≠ actual rows | Planner is misinformed → `ANALYZE`, this causes bad plan choices |
| `Sort` with `external merge Disk` | `work_mem` too small for the sort — expensive on this instance |
| High `shared read=` in BUFFERS | Reading from disk rather than cache |
| `Nested Loop` over many rows | Often the shape behind sudden slowness |

---

## 8. Indexes and table health

### Are indexes being used?

```sql
SELECT relname AS table, indexrelname AS index, idx_scan AS times_used,
       pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
ORDER BY idx_scan ASC
LIMIT 25;
```

`times_used = 0` on a large index means it's dead weight — it costs write performance and disk for nothing. (Exception: unique constraints, which enforce correctness regardless of scans.)

### Tables doing sequential scans

```sql
SELECT relname AS table, seq_scan, idx_scan,
       n_live_tup AS rows,
       pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_stat_user_tables
WHERE seq_scan > 0
ORDER BY seq_scan DESC
LIMIT 20;
```

High `seq_scan` with high `rows` = a missing index. Small tables are fine to scan.

### Biggest tables

```sql
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(relid)) AS total,
       n_live_tup AS live_rows, n_dead_tup AS dead_rows
FROM pg_stat_user_tables
ORDER BY pg_total_relation_size(relid) DESC
LIMIT 20;
```

`dead_rows` approaching `live_rows` means bloat — autovacuum is behind. Fix:

```sql
VACUUM (ANALYZE) <table>;     -- safe online, no exclusive lock
```

`ANALYZE` alone just refreshes planner statistics and is very fast — run it after any bulk import or migration.

---

## 9. Project-specific notes

**Reading Strapi's SQL.** Strapi/knex aliases tables as `t0`, `t1`, `t2`… so query text looks anonymous. The real table appears after `from "public"."<table>" as "t0"`. Link tables are named `<a>_<b>_lnk` (e.g. `coupons_stores_lnk`).

**`SELECT DISTINCT "t0".*` with left joins** is Strapi's populate. It is inherently expensive — DISTINCT over every column of a wide row. If one of these dominates §3, the fix is trimming the populate in application code, not indexing.

**Known heavy hitters** (measured July 2026, cumulative): paginated `stores` scans and `stores`-by-slug lookups dominate by call count, driven by the render pipeline. `files_related_mph` (media) and `deals_tags_lnk` run in the millions of calls. A `select count(id) from admin_users` firing over a million times is pure overhead worth chasing.

**Search queries** must use the `o.id IN (… UNION ALL …)` shape. If you see `OR EXISTS(...)` chains in `pg_stat_statements` with multi-second averages, that is the *old* pre-July-2026 shape — either an old image is deployed or you are looking at pre-fix history. The fixed form runs ~100ms.

**The cron scheduler** runs every 5 minutes and scans coupons for scheduled/expired transitions. Seeing it once per 5 min at a few hundred ms is normal.

---

## 10. Quick triage sequence

Site feels slow, in order:

1. **§1** — what's running now? Anything over 5 seconds?
2. **§4** — connections near 22? Any `idle in transaction`?
3. **§5** — anything blocked on locks?
4. **§3** — worst queries by `total_sec`; decide bad-query vs too-many-queries
5. **§7** — `EXPLAIN (ANALYZE, BUFFERS)` the offender
6. **§8** — missing index, or stale stats needing `ANALYZE`?

If §1–§5 all look clean but the site is still slow, the bottleneck is **not** the database — check the gateway (`/healthz`), Redis, and the render queue instead.
