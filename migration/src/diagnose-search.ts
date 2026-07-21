/**
 * Read-only diagnostic for the slow public /api/search on the DEPLOYED
 * database (whatever PG_CONNECTION_STRING resolves to). Answers, in one run,
 * WHY search is slow enough to trip the isr-gateway 5s timeout (504):
 *
 *   a. server basics (version, memory/parallelism settings, connection load)
 *   b. pg_trgm extension + health of the 11 expected trigram GIN indexes
 *   c. content/link table sizes, vacuum/analyze recency, seq vs index scans
 *   d. presence of owner-column indexes on the _lnk join tables
 *   e. EXPLAIN (ANALYZE, BUFFERS) of the exact 12 preview-mode queries
 *   f. pg_stat_statements top offenders (when the extension is installed)
 *
 * Strictly read-only: the session runs with default_transaction_read_only=on,
 * so any accidental write fails with 25006. Every statement is bounded by
 * statement_timeout (default 30s) — a timeout is reported as a finding, not a
 * crash. EXPLAIN ANALYZE does execute the SELECTs; pass --skip-analyze for
 * plan-only EXPLAIN if even that is too heavy.
 *
 *   yarn diagnose:search                          # query 'mynt', 30s cap
 *   yarn diagnose:search --query "hdfc bank"
 *   yarn diagnose:search --skip-analyze --timeout 15000
 *   yarn diagnose:search --json ./report.json
 */

import { writeFileSync } from "fs";
import { config } from "./config.js";
import { getPgPool, closePg } from "./db/pg-client.js";
import type {
  EntityTable,
  OfferKind,
  SearchNeedles,
  SqlQuery,
} from "../../src/api/search/services/search-sql.js";

// search-sql.ts sits in a CJS package scope (cguruadmin has no
// "type":"module"); a STATIC named import of tsx's CJS-transpiled output
// fails at runtime (cjs-module-lexer cannot see esbuild's getter exports) —
// only tsx's dynamic-import interop keeps the names. Same pattern as
// utils/image-optimizer.ts.
const { asciiFold, entityCountQuery, entityRankedQuery, offerCountQuery, offerRankedQuery } =
  await import("../../src/api/search/services/search-sql.js");

// ── Constants mirrored from the production search service ────────────────
// Kept in sync by hand with cguruadmin/src/api/search/services/search.ts
// (EXPECTED_SEARCH_INDEX_DEFINITIONS, preview limits) and
// cguruadmin/src/api/search/services/search-sql.ts (OFFER_RELATIONS).
// Drift only affects diagnostics, never production behaviour.

const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 80;
const PREVIEW_ENTITY_LIMIT = 7;
const PREVIEW_OFFER_LIMIT = 3;
const PREVIEW_BACKFILL = 2;

const EXPECTED_INDEXES = [
  { name: "stores_name_search_trgm_idx", table: "stores", column: "name" },
  { name: "brands_name_search_trgm_idx", table: "brands", column: "name" },
  { name: "categories_name_search_trgm_idx", table: "categories", column: "name" },
  { name: "banks_name_search_trgm_idx", table: "banks", column: "name" },
  { name: "coupons_title_search_trgm_idx", table: "coupons", column: "title" },
  { name: "deals_title_search_trgm_idx", table: "deals", column: "title" },
  { name: "stores_slug_search_trgm_idx", table: "stores", column: "slug" },
  { name: "brands_slug_search_trgm_idx", table: "brands", column: "slug" },
  { name: "categories_slug_search_trgm_idx", table: "categories", column: "slug" },
  { name: "banks_slug_search_trgm_idx", table: "banks", column: "slug" },
  { name: "coupons_code_search_trgm_idx", table: "coupons", column: "code" },
];

const CONTENT_TABLES = ["stores", "brands", "categories", "banks", "coupons", "deals"];
const LNK_TABLES: Array<{ table: string; ownerColumn: string }> = [
  { table: "coupons_stores_lnk", ownerColumn: "coupon_id" },
  { table: "coupons_brands_lnk", ownerColumn: "coupon_id" },
  { table: "coupons_categories_lnk", ownerColumn: "coupon_id" },
  { table: "coupons_banks_lnk", ownerColumn: "coupon_id" },
  { table: "deals_stores_lnk", ownerColumn: "deal_id" },
  { table: "deals_brands_lnk", ownerColumn: "deal_id" },
  { table: "deals_categories_lnk", ownerColumn: "deal_id" },
  { table: "deals_banks_lnk", ownerColumn: "deal_id" },
  { table: "deals_primary_store_lnk", ownerColumn: "deal_id" },
];

const GENERIC_SLUG_TERMS = new Set([
  "bank", "banks", "brand", "brands", "category", "categories",
  "code", "codes", "coupon", "coupons", "deal", "deals",
  "offer", "offers", "promo", "promos", "store", "stores",
]);

// ── Needle building, replicated from search.ts:320-520 ───────────────────

function queryVariants(query: string): string[] {
  const q = query.trim();
  const variants = new Set([q]);
  const folded = asciiFold(q);

  if (folded.endsWith("ies") && folded.length - 3 >= 3) {
    variants.add(q.slice(0, -3) + "y");
  } else if (/(?:ch|sh|x|z)es$/u.test(folded) && folded.length - 2 >= 3) {
    variants.add(q.slice(0, -2));
  } else if (
    folded.endsWith("s") &&
    !/(?:ss|us|is)$/u.test(folded) &&
    folded.length - 1 >= 3
  ) {
    variants.add(q.slice(0, -1));
  }
  return [...variants];
}

function filterNeedles(variants: string[]): string[] {
  const folded = variants.map(asciiFold);
  return variants.filter((_, index) =>
    folded.every(
      (other, otherIndex) =>
        otherIndex === index || !folded[index].includes(other),
    ),
  );
}

function slugNeedle(value: string): string | null {
  const normalized = value.normalize("NFKC");
  if (!/^[\x00-\x7F]*$/u.test(normalized)) return null;
  const needle = asciiFold(normalized)
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!needle || GENERIC_SLUG_TERMS.has(needle)) return null;
  return needle;
}

function searchNeedles(query: string): SearchNeedles {
  const variants = queryVariants(query);
  const whereNeedles = filterNeedles(variants);
  const slugNeedles = Array.from(
    new Set(whereNeedles.map(slugNeedle).filter(Boolean)),
  ) as string[];
  return { variants, whereNeedles, slugNeedles };
}

// ── CLI ──────────────────────────────────────────────────────────────────

type CliOptions = {
  query: string;
  skipAnalyze: boolean;
  jsonPath: string;
  timeoutMs: number;
};

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && index + 1 < process.argv.length
    ? process.argv[index + 1]
    : null;
}

function parseArgs(): CliOptions {
  const query = (argValue("--query") ?? "mynt").normalize("NFKC").trim();
  const length = [...query].length;
  if (length < MIN_QUERY_LENGTH || length > MAX_QUERY_LENGTH) {
    throw new Error(
      `--query must be ${MIN_QUERY_LENGTH}-${MAX_QUERY_LENGTH} characters (got ${length})`,
    );
  }
  const timeoutMs = parseInt(argValue("--timeout") ?? "30000", 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
    throw new Error("--timeout must be a number of milliseconds >= 1000");
  }
  return {
    query,
    skipAnalyze: process.argv.includes("--skip-analyze"),
    jsonPath:
      argValue("--json") ??
      `diagnose-search-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
    timeoutMs,
  };
}

// ── Execution helpers ────────────────────────────────────────────────────

type Client = import("pg").PoolClient;

type StepResult<T = any> = {
  ok: boolean;
  ms: number;
  rows?: T[];
  error?: string;
  timedOut?: boolean;
};

async function timed<T = any>(client: Client, sql: string): Promise<StepResult<T>> {
  const start = process.hrtime.bigint();
  try {
    const result = await client.query(sql);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { ok: true, ms, rows: result.rows as T[] };
  } catch (err: any) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const timedOut = String(err?.code) === "57014";
    return {
      ok: false,
      ms,
      timedOut,
      error: timedOut
        ? `exceeded statement_timeout after ${Math.round(ms)}ms — this itself is a strong slowness signal`
        : String(err?.message ?? err),
    };
  }
}

function sqlLiteral(value: string | number): string {
  return typeof value === "number"
    ? String(value)
    : `'${value.replace(/'/gu, "''")}'`;
}

// The builder SQL text contains no literal '?' outside placeholders (only
// ESCAPE '\', translate alphabets, and identifiers), so blind replacement is
// sound; the count assertion guards against builder drift. Inlined literals
// give the planner the same visibility as production's per-execution custom
// plans. LIKE-pattern backslashes are fine under standard_conforming_strings.
function inlineBindings({ sql, bindings }: SqlQuery): string {
  let index = 0;
  const inlined = sql.replace(/\?/gu, () => sqlLiteral(bindings[index++]));
  if (index !== bindings.length) {
    throw new Error(
      `placeholder/binding mismatch: ${index} placeholders vs ${bindings.length} bindings`,
    );
  }
  return inlined;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function marker(result: StepResult): string {
  if (result.timedOut) return "TIMEOUT";
  if (!result.ok) return "FAIL";
  if (result.ms > 1000) return "SLOW";
  return "OK";
}

// ── Section a: server basics ─────────────────────────────────────────────

async function checkServerBasics(client: Client) {
  const version = await timed<{ version: string }>(client, "SELECT version()");
  const settings = await timed<{ name: string; setting: string; unit: string | null }>(
    client,
    `SELECT name, setting, unit FROM pg_settings WHERE name IN (
       'work_mem','shared_buffers','max_connections','jit','effective_cache_size',
       'random_page_cost','max_parallel_workers_per_gather','statement_timeout')
     ORDER BY name`,
  );
  const activity = await timed<{ state: string | null; count: string }>(
    client,
    `SELECT coalesce(state, '(backend)') AS state, count(*)::text AS count
     FROM pg_stat_activity GROUP BY 1 ORDER BY 2 DESC`,
  );
  return {
    version: version.rows?.[0]?.version ?? version.error,
    settings: settings.rows ?? [],
    settingsError: settings.error,
    activity: activity.rows ?? [],
    activityError: activity.error,
  };
}

// ── Section b: pg_trgm + expected trigram indexes ────────────────────────

function canonicalIndexExpression(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, "")
    .replace(/::(?:text|charactervarying)/giu, "")
    .replace(/"/gu, "")
    .replace(/\(([a-z_][a-z0-9_$]*)\)/giu, "$1")
    .replace(/^translate(?=\()/iu, "translate");
}

function expectedIndexExpression(column: string): string {
  return (
    `translate(${column},` +
    `'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')`
  );
}

type IndexHealth = {
  name: string;
  table: string;
  column: string;
  exists: boolean;
  healthy: boolean;
  problems: string[];
};

async function checkTrgmAndIndexes(client: Client) {
  const extension = await timed<{ schema_name: string }>(
    client,
    `SELECT extension_namespace.nspname AS schema_name
     FROM pg_extension ext
     JOIN pg_namespace extension_namespace ON extension_namespace.oid = ext.extnamespace
     WHERE ext.extname = 'pg_trgm'`,
  );
  const pgTrgmSchema = extension.rows?.[0]?.schema_name ?? null;

  const indexes: IndexHealth[] = [];
  for (const expected of EXPECTED_INDEXES) {
    // Same catalog inspection as database/search-index-migration.js
    // inspectExpectedIndex, rewritten with pg-style $n parameters.
    const result = await client.query(
      `SELECT table_namespace.nspname AS table_schema,
              table_class.relname AS table_name,
              access_method.amname AS access_method,
              index_state.indnkeyatts AS key_count,
              pg_get_indexdef(index_state.indexrelid, 1, true) AS expression,
              opclass.opcname AS opclass_name,
              opclass_namespace.nspname AS opclass_schema,
              pg_get_expr(index_state.indpred, index_state.indrelid) AS predicate,
              index_state.indisvalid, index_state.indisready
       FROM pg_class index_class
       JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
       JOIN pg_index index_state ON index_state.indexrelid = index_class.oid
       JOIN pg_class table_class ON table_class.oid = index_state.indrelid
       JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
       JOIN pg_am access_method ON access_method.oid = index_class.relam
       LEFT JOIN pg_opclass opclass ON opclass.oid = index_state.indclass[0]
       LEFT JOIN pg_namespace opclass_namespace ON opclass_namespace.oid = opclass.opcnamespace
       WHERE index_namespace.nspname = current_schema() AND index_class.relname = $1
       LIMIT 1`,
      [expected.name],
    );
    const row = result.rows[0];
    if (!row) {
      indexes.push({ ...expected, exists: false, healthy: false, problems: ["missing"] });
      continue;
    }
    const problems: string[] = [];
    if (String(row.table_name ?? "") !== expected.table) {
      problems.push(`on wrong table ${row.table_schema}.${row.table_name}`);
    }
    if (String(row.access_method ?? "") !== "gin") problems.push("not a GIN index");
    if (Number(row.key_count) !== 1) problems.push("more than one key column");
    if (
      canonicalIndexExpression(row.expression) !==
      expectedIndexExpression(expected.column)
    ) {
      problems.push(`wrong expression: ${row.expression}`);
    }
    if (String(row.opclass_name ?? "") !== "gin_trgm_ops") {
      problems.push(`opclass is ${row.opclass_name}, not gin_trgm_ops`);
    } else if (pgTrgmSchema && String(row.opclass_schema ?? "") !== pgTrgmSchema) {
      problems.push(`gin_trgm_ops is not from schema ${pgTrgmSchema}`);
    }
    if (row.predicate != null) problems.push("index is partial");
    if (row.indisvalid !== true) problems.push("indisvalid=false (broken CONCURRENTLY build?)");
    if (row.indisready !== true) problems.push("indisready=false");
    indexes.push({
      ...expected,
      exists: true,
      healthy: problems.length === 0,
      problems,
    });
  }

  return { pgTrgmSchema, extensionError: extension.error, indexes };
}

// ── Section c: table stats ───────────────────────────────────────────────

async function checkTableStats(client: Client) {
  const allTables = [...CONTENT_TABLES, ...LNK_TABLES.map(({ table }) => table)];
  const stats = await timed(
    client,
    `SELECT stat.relname AS table_name,
            pg_class.reltuples::bigint AS estimated_rows,
            stat.n_live_tup, stat.n_dead_tup,
            stat.seq_scan, stat.idx_scan,
            stat.last_vacuum, stat.last_autovacuum,
            stat.last_analyze, stat.last_autoanalyze,
            pg_size_pretty(pg_total_relation_size(pg_class.oid)) AS total_size,
            pg_size_pretty(pg_relation_size(pg_class.oid)) AS table_size,
            pg_size_pretty(pg_indexes_size(pg_class.oid)) AS indexes_size,
            pg_total_relation_size(pg_class.oid) AS total_size_bytes
     FROM pg_stat_user_tables stat
     JOIN pg_class ON pg_class.oid = stat.relid
     WHERE stat.schemaname = current_schema()
       AND stat.relname = ANY(${sqlLiteral(`{${allTables.join(",")}}`)}::text[])
     ORDER BY pg_total_relation_size(pg_class.oid) DESC`,
  );

  const exactCounts: Record<string, string> = {};
  for (const table of allTables) {
    const count = await timed<{ count: string }>(
      client,
      `SELECT count(*)::text AS count FROM "${table}"`,
    );
    exactCounts[table] = count.ok
      ? count.rows![0].count
      : `(${count.timedOut ? "count timed out" : count.error})`;
  }

  return { stats: stats.rows ?? [], statsError: stats.error, exactCounts };
}

// ── Section d: link-table owner indexes ──────────────────────────────────

async function checkLnkIndexes(client: Client) {
  const result = await timed<{ tablename: string; indexname: string; indexdef: string }>(
    client,
    `SELECT tablename, indexname, indexdef FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = ANY(${sqlLiteral(`{${LNK_TABLES.map(({ table }) => table).join(",")}}`)}::text[])
     ORDER BY tablename, indexname`,
  );
  const rows = result.rows ?? [];
  const missingOwnerIndex = LNK_TABLES.filter(({ table, ownerColumn }) => {
    const defs = rows.filter((row) => row.tablename === table);
    // The correlated EXISTS/MIN(tier) probes filter on the owner column, so
    // it must be the LEADING key of some index to avoid per-probe seq scans.
    return !defs.some((row) =>
      new RegExp(`\\("?${ownerColumn}"?[,)\\s]`, "u").test(row.indexdef),
    );
  }).map(({ table }) => table);
  return { indexes: rows, error: result.error, missingOwnerIndex };
}

// ── Section e: EXPLAIN the 12 preview queries ────────────────────────────

type ExplainResult = {
  label: string;
  marker: string;
  wallMs: number;
  executionMs: number | null;
  observations: string[];
  plan: string[];
  error?: string;
};

function planObservations(plan: string[]): string[] {
  const text = plan.join("\n");
  const observations: string[] = [];
  const seqScans = [...text.matchAll(/Seq Scan on (\w+)/gu)].map((m) => m[1]);
  if (seqScans.length > 0) {
    observations.push(`seq scan on: ${[...new Set(seqScans)].join(", ")}`);
  }
  if (/SubPlan/u.test(text)) observations.push("correlated SubPlan probes");
  if (/external merge|Sort Method: external/u.test(text)) {
    observations.push("sort spilled to disk (work_mem too small)");
  }
  if (/Bitmap Index Scan on \w+_search_trgm_idx/u.test(text)) {
    observations.push("uses trigram index");
  }
  return observations;
}

async function explainPreviewQueries(
  client: Client,
  needles: SearchNeedles,
  skipAnalyze: boolean,
): Promise<ExplainResult[]> {
  const nowIso = new Date().toISOString();
  const entityWindow = { limit: PREVIEW_ENTITY_LIMIT + PREVIEW_BACKFILL, offset: 0 };
  const offerWindow = { limit: PREVIEW_OFFER_LIMIT + PREVIEW_BACKFILL, offset: 0 };

  const queries: Array<{ label: string; query: SqlQuery }> = [
    ...(["stores", "brands", "categories", "banks"] as EntityTable[]).flatMap(
      (table) => [
        { label: `${table}.ranked`, query: entityRankedQuery(table, needles, entityWindow) },
        { label: `${table}.count`, query: entityCountQuery(table, needles) },
      ],
    ),
    ...(["coupon", "deal"] as OfferKind[]).flatMap((kind) => [
      { label: `${kind}s.ranked`, query: offerRankedQuery(kind, needles, offerWindow, nowIso) },
      { label: `${kind}s.count`, query: offerCountQuery(kind, needles, nowIso) },
    ]),
  ];

  const results: ExplainResult[] = [];
  // Sequential on purpose: keeps timings attributable and avoids hitting prod
  // with 12 concurrent heavy queries the way one live preview request does.
  for (const { label, query } of queries) {
    const statement = skipAnalyze
      ? `EXPLAIN ${inlineBindings(query)}`
      : `EXPLAIN (ANALYZE, BUFFERS) ${inlineBindings(query)}`;
    const run = await timed<{ "QUERY PLAN": string }>(client, statement);
    const plan = (run.rows ?? []).map((row) => row["QUERY PLAN"]);
    const executionLine = plan.find((line) => /^Execution Time:/u.test(line));
    results.push({
      label,
      marker: marker(run),
      wallMs: run.ms,
      executionMs: executionLine
        ? Number(executionLine.replace(/[^0-9.]/gu, ""))
        : null,
      observations: run.ok ? planObservations(plan) : [],
      plan,
      error: run.error,
    });
    console.log(
      `  [${marker(run).padEnd(7)}] ${label.padEnd(18)} ${fmtMs(run.ms)}` +
        (run.error ? ` — ${run.error}` : ""),
    );
  }
  return results;
}

// ── Section f: pg_stat_statements ────────────────────────────────────────

async function checkPgStatStatements(client: Client) {
  const result = await timed(
    client,
    `SELECT calls, round(mean_exec_time::numeric, 1) AS mean_ms,
            round(total_exec_time::numeric, 0) AS total_ms, rows,
            left(query, 200) AS query
     FROM pg_stat_statements
     ORDER BY mean_exec_time DESC LIMIT 10`,
  );
  if (!result.ok) {
    return { available: false, note: "pg_stat_statements not available (fine — informational only)" };
  }
  return { available: true, top: result.rows };
}

// ── Findings ─────────────────────────────────────────────────────────────

function deriveFindings(report: any): string[] {
  const findings: string[] = [];
  const { extensionAndIndexes, lnkIndexes, explains, tableStats } = report;

  if (!extensionAndIndexes.pgTrgmSchema) {
    findings.push(
      "pg_trgm extension is NOT installed — none of the 11 trigram indexes can exist, so every " +
        "LIKE '%…%' arm is a sequential scan. Fix: run CREATE EXTENSION pg_trgm; as a " +
        "superuser/rds_superuser on this database, then restart Strapi (its bootstrap " +
        "reconciler creates all indexes automatically) and re-run this script.",
    );
  }
  const unhealthy = extensionAndIndexes.indexes.filter((index: IndexHealth) => !index.healthy);
  if (extensionAndIndexes.pgTrgmSchema && unhealthy.length > 0) {
    findings.push(
      `${unhealthy.length}/11 expected trigram indexes are missing or unhealthy: ` +
        unhealthy.map((index: IndexHealth) => `${index.name} (${index.problems.join("; ")})`).join(", ") +
        ". Fix: restart Strapi off-peak (the boot reconciler retries), or CREATE INDEX " +
        "CONCURRENTLY with the exact translate(...) gin_trgm_ops expression.",
    );
  }

  if (lnkIndexes.missingOwnerIndex.length > 0) {
    findings.push(
      `Link tables without a leading owner-column index: ${lnkIndexes.missingOwnerIndex.join(", ")} — ` +
        "every correlated EXISTS/MIN(tier) probe seq-scans them. Fix: add btree indexes on the " +
        "coupon_id/deal_id column (Strapi normally creates _fk indexes; investigate why absent).",
    );
  }

  const slowExplains = explains.filter(
    (item: ExplainResult) => item.marker === "SLOW" || item.marker === "TIMEOUT",
  );
  for (const item of slowExplains) {
    findings.push(
      `Query ${item.label} took ${fmtMs(item.wallMs)}${item.marker === "TIMEOUT" ? " (timed out)" : ""}` +
        (item.observations.length > 0 ? ` — ${item.observations.join("; ")}` : "") +
        ".",
    );
  }
  const offerSeqScan = explains.some(
    (item: ExplainResult) =>
      /^(coupons|deals)\./u.test(item.label) &&
      item.wallMs > 1000 &&
      item.observations.some((obs: string) => /seq scan on: .*(coupons|deals)/u.test(obs)),
  );
  if (offerSeqScan) {
    findings.push(
      "Coupons/deals queries seq-scan the offer table with per-row link probes: the " +
        "'direct LIKE OR 4-5x EXISTS' WHERE shape cannot use one index. Fix (code change in " +
        "search-sql.ts): restructure membership as index-friendly arms " +
        "(o.id IN (direct matches UNION ids from lnk joins)) or precompute a denormalized " +
        "search table.",
    );
  }

  for (const row of tableStats.stats) {
    const dead = Number(row.n_dead_tup);
    const live = Number(row.n_live_tup);
    if (live > 0 && dead / live > 0.2) {
      findings.push(
        `${row.table_name}: ${dead} dead tuples vs ${live} live (>${Math.round((dead / live) * 100)}%) — ` +
          "bloat/stale stats. Fix: VACUUM (ANALYZE) off-peak; check autovacuum settings.",
      );
    }
    if (!row.last_analyze && !row.last_autoanalyze && live > 0) {
      findings.push(
        `${row.table_name}: never analyzed — the planner is flying blind after the bulk ` +
          "migration load. Fix: run ANALYZE on this table.",
      );
    }
  }

  const diskSort = explains.some((item: ExplainResult) =>
    item.observations.includes("sort spilled to disk (work_mem too small)"),
  );
  if (diskSort) {
    findings.push(
      "At least one plan sorts on disk — work_mem is too small for these queries. " +
        "Fix: raise work_mem moderately (per-connection cost applies).",
    );
  }

  if (findings.length === 0) {
    findings.push(
      "All 12 preview queries ran fast against this database and index health checks passed. " +
        "The bottleneck is likely NOT raw SQL: inspect Strapi's pool saturation " +
        "(DATABASE_POOL_MAX vs 12 parallel queries per request), the document-service " +
        "hydration step, network latency between Strapi and the DB, or the isr-gateway " +
        "5s SEARCH_TIMEOUT_MS being too tight for cold caches.",
    );
  }
  return findings;
}

// ── Report printing ──────────────────────────────────────────────────────

function printSection(title: string) {
  console.log(`\n━━━ ${title} ${"━".repeat(Math.max(0, 60 - title.length))}`);
}

function printReport(report: any) {
  printSection("a. Server");
  console.log(`  ${report.server.version}`);
  for (const row of report.server.settings) {
    console.log(`  ${row.name} = ${row.setting}${row.unit ? ` ${row.unit}` : ""}`);
  }
  console.log(
    `  connections: ${report.server.activity
      .map((row: any) => `${row.state}=${row.count}`)
      .join(", ")}`,
  );

  printSection("b. pg_trgm + expected indexes");
  console.log(
    `  pg_trgm: ${report.extensionAndIndexes.pgTrgmSchema ? `installed (schema ${report.extensionAndIndexes.pgTrgmSchema})` : "NOT INSTALLED"}`,
  );
  for (const index of report.extensionAndIndexes.indexes) {
    console.log(
      `  [${index.healthy ? "OK" : "FAIL"}] ${index.name}` +
        (index.healthy ? "" : ` — ${index.problems.join("; ")}`),
    );
  }

  printSection("c. Table stats");
  for (const row of report.tableStats.stats) {
    console.log(
      `  ${String(row.table_name).padEnd(26)} rows=${report.tableStats.exactCounts[row.table_name] ?? row.estimated_rows}` +
        ` dead=${row.n_dead_tup} size=${row.total_size} seq_scan=${row.seq_scan} idx_scan=${row.idx_scan}` +
        ` last_analyze=${row.last_autoanalyze ?? row.last_analyze ?? "never"}`,
    );
  }

  printSection("d. Link-table owner indexes");
  if (report.lnkIndexes.missingOwnerIndex.length === 0) {
    console.log("  [OK] every _lnk table has a leading owner-column index");
  } else {
    console.log(`  [FAIL] missing on: ${report.lnkIndexes.missingOwnerIndex.join(", ")}`);
  }

  // Section e prints incrementally while running; summarize slow plans here.
  printSection("e. Slow query plans (>1s)");
  const slow = report.explains.filter(
    (item: ExplainResult) => item.marker === "SLOW" || item.marker === "TIMEOUT",
  );
  if (slow.length === 0) console.log("  none — all 12 queries under 1s");
  for (const item of slow) {
    console.log(`\n  ── ${item.label} (${fmtMs(item.wallMs)}) ──`);
    for (const line of item.plan) console.log(`  ${line}`);
  }

  printSection("f. pg_stat_statements");
  if (!report.statStatements.available) {
    console.log(`  ${report.statStatements.note}`);
  } else {
    for (const row of report.statStatements.top) {
      console.log(`  ${row.mean_ms}ms avg × ${row.calls} calls — ${row.query.replace(/\s+/gu, " ")}`);
    }
  }

  printSection("FINDINGS");
  report.findings.forEach((finding: string, index: number) => {
    console.log(`\n  ${index + 1}. ${finding}`);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const options = parseArgs();
  const host = new URL(config.pg.connectionString).hostname;
  const needles = searchNeedles(options.query);
  console.log(
    `diagnose-search → host=${host} query=${JSON.stringify(options.query)} ` +
      `mode=${options.skipAnalyze ? "EXPLAIN only" : "EXPLAIN ANALYZE"} timeout=${options.timeoutMs}ms`,
  );
  console.log(`needles: ${JSON.stringify(needles)}`);

  const pool = getPgPool();
  const client = await pool.connect();
  try {
    // Session-level guarantees: writes fail (25006), no statement can run
    // longer than the cap, and the session is identifiable in pg_stat_activity.
    await client.query("SET default_transaction_read_only = on");
    await client.query(`SET statement_timeout = ${options.timeoutMs}`);
    await client.query("SET application_name = 'diagnose-search'");

    const server = await checkServerBasics(client);
    const extensionAndIndexes = await checkTrgmAndIndexes(client);
    const tableStats = await checkTableStats(client);
    const lnkIndexes = await checkLnkIndexes(client);
    printSection(`e. EXPLAIN${options.skipAnalyze ? "" : " (ANALYZE, BUFFERS)"} — 12 preview queries`);
    const explains = await explainPreviewQueries(client, needles, options.skipAnalyze);
    const statStatements = await checkPgStatStatements(client);

    const report = {
      meta: {
        host,
        query: options.query,
        needles,
        timestamp: new Date().toISOString(),
        skipAnalyze: options.skipAnalyze,
        timeoutMs: options.timeoutMs,
      },
      server,
      extensionAndIndexes,
      tableStats,
      lnkIndexes,
      explains,
      statStatements,
      findings: [] as string[],
    };
    report.findings = deriveFindings(report);

    printReport(report);
    writeFileSync(options.jsonPath, JSON.stringify(report, null, 2));
    console.log(`\nFull JSON report written to ${options.jsonPath}`);
  } catch (err: any) {
    console.error(`diagnose-search failed: ${err?.message ?? err}`);
    console.error(err?.stack);
    process.exitCode = 1;
  } finally {
    client.release();
    await closePg();
  }
}

await main();
