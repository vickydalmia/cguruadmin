// Search POSTGRES EXECUTION: the ranked SQL reads, document hydration, and
// the per-request phase telemetry they feed. One of the modules split out
// of the search service (see ./search.ts).
import { AsyncLocalStorage } from "node:async_hooks";
import type { Core } from "@strapi/strapi";
import {
  asciiFold,
  entityCountQuery,
  entityRankedQuery,
  isPostgresClient,
  NO_MATCH_TIER,
  offerCountQuery,
  offerRankedQuery,
  RELATION_TIER_SHIFT,
  VARIANT_TIER_SHIFT,
  type OfferKind,
  type SearchNeedles,
  type SqlQuery,
} from "./search-sql";
import {
  COUPON_FIELDS,
  DEAL_FIELDS,
  couponPopulate,
  dealPopulate,
  entityFields,
  relations,
  type EntityConfig,
} from "./search-config";

export type PageWindow = {
  limit: number;
  offset: number;
  // Preview-only over-fetch (PREVIEW_BACKFILL): extra ranked rows fetched
  // beyond `limit` so null-mapping or visibility-dropped rows backfill
  // instead of shrinking the list. Undefined on group pages — pagination
  // must not shift, so only preview backfills; a dropped row on a paged
  // request shortens that page instead.
  lookahead?: number;
};

// Per-request phase accounting for slow-search diagnostics. Requests fan out
// concurrently (Promise.all across groups), so the sums are cumulative
// busy-time per phase, not wall time — their ratio says which phase dominates
// a slow request. Threaded via AsyncLocalStorage so the many helper
// signatures stay untouched. Logging is bounded to requests slower than
// SEARCH_SLOW_LOG_MS (default 500ms, 0 disables) and never includes the
// query text.
export const SEARCH_SLOW_LOG_MS = Number(process.env.SEARCH_SLOW_LOG_MS ?? 500);

export type SearchPhaseStats = {
  sql: number;
  sqlCalls: number;
  hydrate: number;
  hydrateCalls: number;
};

export const searchPhaseStorage = new AsyncLocalStorage<SearchPhaseStats>();

export function recordPhase(phase: "sql" | "hydrate", startedAt: number) {
  const stats = searchPhaseStorage.getStore();
  if (!stats) return;
  stats[phase] += Date.now() - startedAt;
  stats[phase === "sql" ? "sqlCalls" : "hydrateCalls"] += 1;
}

export async function rankedRows(connection: any, query: SqlQuery): Promise<any[]> {
  const startedAt = Date.now();
  try {
    const result = await connection.raw(query.sql, query.bindings);
    return result?.rows ?? [];
  } finally {
    recordPhase("sql", startedAt);
  }
}

export async function rankedDocumentIds(
  connection: any,
  query: SqlQuery,
): Promise<string[]> {
  return (await rankedRows(connection, query)).map((row) =>
    String(row.document_id),
  );
}

export async function rankedTotal(connection: any, query: SqlQuery): Promise<number> {
  const rows = await rankedRows(connection, query);
  return Number(rows[0]?.total ?? 0);
}

// Hydration runs after the ranked-ID query, so a row can change state in
// between (offer expires or unpublishes, entity loses its publish). The
// caller's visibility filters are re-applied here so such a row is dropped
// instead of served. Dropped ids still shrink the page — there is no
// backfill at this layer; preview covers the gap with its PageWindow
// lookahead over-fetch, while paged groups serve one short page until the
// next request re-ranks.
export async function hydrateByDocumentId(
  strapi: Core.Strapi,
  uid: string,
  documentIds: string[],
  options: {
    fields: string[];
    populate: Record<string, any>;
    visibility: Record<string, any>;
    locale: string;
  },
) {
  if (documentIds.length === 0) return [];
  const startedAt = Date.now();
  const documents = await strapi
    .documents(uid as any)
    .findMany({
      filters: {
        $and: [{ documentId: { $in: documentIds } }, options.visibility],
      },
      fields: options.fields,
      populate: options.populate,
      locale: options.locale,
      limit: documentIds.length,
    } as any)
    .finally(() => recordPhase("hydrate", startedAt));
  const order = new Map(documentIds.map((id, index) => [id, index]));
  return [...documents].sort(
    (a: any, b: any) =>
      (order.get(String(a?.documentId)) ?? 0) -
      (order.get(String(b?.documentId)) ?? 0),
  );
}
