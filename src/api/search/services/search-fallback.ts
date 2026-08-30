// Search QUERY-ENGINE FALLBACK: the full-set document reads and in-process
// ranking used when the runtime mode is not postgres-sql. One of the
// modules split out of the search service (see ./search.ts).
import type { Core } from "@strapi/strapi";
import { publishedOnlyFilters } from "../../../utils/content-status";
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
import {
  normalizeLabel,
  rank,
  relevanceForVariants,
  searchNeedles,
} from "./search-ranking";
import { relatedEntities } from "./search-response";

export type FallbackRequestCache = Map<string, Promise<any[]>>;

function literalContains(value: unknown, needles: string[]): boolean {
  if (typeof value !== "string") return false;
  const candidate = normalizeLabel(value);
  return needles.some((needle) => candidate.includes(normalizeLabel(needle)));
}

function literalSlugPrefix(value: unknown, needles: string[]): boolean {
  if (typeof value !== "string") return false;
  const candidate = normalizeLabel(value);
  return needles.some((needle) => candidate.startsWith(needle));
}

function entityMatches(document: any, needles: SearchNeedles): boolean {
  return (
    literalContains(document?.name, needles.whereNeedles) ||
    literalSlugPrefix(document?.slug, needles.slugNeedles)
  );
}

const FALLBACK_READ_BATCH_SIZE = 500;

export function offerMatches(
  document: any,
  kind: OfferKind,
  needles: SearchNeedles,
): boolean {
  if (literalContains(document?.title, needles.whereNeedles)) return true;
  if (
    kind === "coupon" &&
    literalContains(document?.code, needles.whereNeedles)
  ) {
    return true;
  }
  return relatedEntities(document).some(
    (relation) =>
      literalContains(relation?.name, needles.whereNeedles) ||
      literalSlugPrefix(relation?.slug, needles.slugNeedles),
  );
}

// Non-Postgres is a correctness fallback, not a candidate-window heuristic.
// Read every visible row in deterministic 500-row batches, then perform
// literal membership, ranking, counting, and pagination over the full set in
// JS. In particular %, _, and backslash have no wildcard meaning here.
async function readAllDocuments(
  strapi: Core.Strapi,
  uid: string,
  options: {
    status: "published";
    filters: Record<string, any>;
    fields: string[];
    populate: Record<string, any>;
    locale: string;
  },
): Promise<any[]> {
  const documents: any[] = [];
  let start = 0;
  let previousFullBatch = "";
  for (;;) {
    const batch = await strapi.documents(uid as any).findMany({
      ...options,
      sort: [{ documentId: "asc" }],
      start,
      limit: FALLBACK_READ_BATCH_SIZE,
    } as any);
    if (!Array.isArray(batch)) {
      throw new Error(`Search fallback ${uid} read did not return an array`);
    }
    documents.push(...batch);
    if (batch.length < FALLBACK_READ_BATCH_SIZE) break;

    // Guard against an adapter silently ignoring `start`, which would
    // otherwise spin forever and repeatedly append the same page.
    const signature = [
      batch.length,
      String(batch[0]?.documentId ?? batch[0]?.id ?? ""),
      String(batch.at(-1)?.documentId ?? batch.at(-1)?.id ?? ""),
    ].join(":");
    if (signature === previousFullBatch) {
      throw new Error(`Search fallback ${uid} pagination did not advance`);
    }
    previousFullBatch = signature;
    start += FALLBACK_READ_BATCH_SIZE;
  }
  return documents;
}

export function cachedFallbackRead(
  cache: FallbackRequestCache,
  key: string,
  load: () => Promise<any[]>,
): Promise<any[]> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

export function fallbackEntities(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
  cache: FallbackRequestCache,
  locale: string,
): Promise<any[]> {
  return cachedFallbackRead(cache, `entity:${config.key}:${locale}`, async () => {
    const needles = searchNeedles(query);
    const documents = await readAllDocuments(strapi, config.uid, {
      status: "published",
      filters: {},
      fields: entityFields(config),
      populate: { [config.mediaField]: true },
      locale,
    });
    return documents.filter((document) => entityMatches(document, needles));
  });
}

export function fallbackOffers(
  strapi: Core.Strapi,
  kind: OfferKind,
  query: string,
  cache: FallbackRequestCache,
  nowIso: string,
  locale: string,
): Promise<any[]> {
  return cachedFallbackRead(cache, `offer:${kind}:${locale}`, async () => {
    const needles = searchNeedles(query);
    const documents = await readAllDocuments(
      strapi,
      kind === "coupon" ? "api::coupon.coupon" : "api::deal.deal",
      kind === "coupon"
        ? {
            status: "published",
            filters: publishedOnlyFilters(nowIso),
            fields: COUPON_FIELDS,
            populate: couponPopulate,
            locale,
          }
        : {
            status: "published",
            filters: publishedOnlyFilters(nowIso),
            fields: DEAL_FIELDS,
            populate: dealPopulate,
            locale,
          },
    );
    return documents.filter((document) =>
      offerMatches(document, kind, needles),
    );
  });
}

export function rankOfferDocuments(
  items: any[],
  kind: OfferKind,
  query: string,
) {
  return rank(
    items,
    query,
    (item) => [
      { value: String(item?.title ?? ""), shift: 0 },
      ...(kind === "coupon" && typeof item?.code === "string"
        ? [{ value: item.code, shift: 0 }]
        : []),
      ...relatedEntities(item).map((relation) => ({
        value: String(relation?.name ?? ""),
        shift: RELATION_TIER_SHIFT,
      })),
    ],
    (item) => String(item?.title ?? ""),
  );
}

// ── Ranked-SQL execution (Postgres only) ────────────────────────────────
// Two-step pattern: raw SQL returns exactly the page of ranked document ids,
// then only those ids are hydrated through the document service (same
// fields/populate as the fallback finders) and reordered to the SQL order.
