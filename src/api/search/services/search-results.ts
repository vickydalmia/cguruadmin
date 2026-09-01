// Search RESPONSE COMPOSITION: per-mode page loads, totals, preview
// backfill and group pagination envelopes. One of the modules split out of
// the search service (see ./search.ts).
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
import { publishedOnlyFilters } from "../../../utils/content-status";
// Public search serves the default-locale catalogue. The ranked SQL must say
// so explicitly — the tables hold one row per locale once i18n is enabled —
// while the documents-API hydrate/fallback reads already default to the
// default locale. A localized search (e.g. /ar/) threads its own locale here
// when the storefront grows one.
import { DEFAULT_CONTENT_LOCALE } from "../../../constants/content-locales";
import {
  GROUPS,
  MAX_PAGE,
  normalizeQuery,
  type SearchGroup,
  type SearchRequest,
} from "./search-request";
import {
  COUPON_FIELDS,
  DEAL_FIELDS,
  ENTITIES,
  couponPopulate,
  dealPopulate,
  entityFields,
  type EntityConfig,
} from "./search-config";
import { rank, searchNeedles, slugNeedle } from "./search-ranking";
import { mapEntity, mapOffer, toPublicOffer } from "./search-response";
import {
  cachedFallbackRead,
  fallbackEntities,
  fallbackOffers,
  rankOfferDocuments,
  type FallbackRequestCache,
} from "./search-fallback";
import {
  hydrateByDocumentId,
  rankedDocumentIds,
  rankedRows,
  rankedTotal,
  type PageWindow,
} from "./search-postgres";
import { withSearchMode } from "./search-runtime";

const PREVIEW_ENTITY_LIMIT = 7;
const PREVIEW_OFFER_LIMIT = 3;
// Preview-only null-backfill margin: a ranked row can hydrate but map to
// null (missing name/slug) or get dropped by the hydrate visibility
// re-check, which would shrink the preview list below its display limit.
// Preview windows over-fetch this many extra ranked ids so dropped rows
// backfill from the next candidates. Paged group requests never over-fetch —
// their LIMIT/OFFSET must stay exact or page boundaries would shift.
const PREVIEW_BACKFILL = 2;

export async function entityPage(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
  window: PageWindow,
  fallbackCache: FallbackRequestCache,
  locale = DEFAULT_CONTENT_LOCALE,
) {
  return withSearchMode(
    strapi,
    async (connection) => {
      const ids = await rankedDocumentIds(
        connection,
        entityRankedQuery(
          config.key,
          searchNeedles(query),
          {
            limit: window.limit + (window.lookahead ?? 0),
            offset: window.offset,
          },
          locale,
        ),
      );
      const documents = await hydrateByDocumentId(strapi, config.uid, ids, {
        fields: entityFields(config),
        populate: { [config.mediaField]: true },
        // Same published constraint as the ranked SQL WHERE.
        visibility: { publishedAt: { $notNull: true } },
        locale,
      });
      return documents
        .map((item) => mapEntity(item, config))
        .filter(Boolean)
        .slice(0, window.limit);
    },
    async () => {
      const documents = await fallbackEntities(
        strapi,
        config,
        query,
        fallbackCache,
        locale,
      );
      const ranked = rank(
        documents,
        query,
        (item) => [{ value: item?.name ?? "", shift: 0 }],
        (item) => item?.name ?? "",
      );
      // Preview (lookahead set) maps before slicing so a null-mapping row
      // backfills from the full matching set; paged groups slice first —
      // their LIMIT/OFFSET are exact and must not shift when a row maps to
      // null, so only preview backfills.
      if (window.lookahead !== undefined) {
        return ranked
          .map((item) => mapEntity(item, config))
          .filter(Boolean)
          .slice(0, window.limit);
      }
      return ranked
        .slice(window.offset, window.offset + window.limit)
        .map((item) => mapEntity(item, config))
        .filter(Boolean);
    },
  );
}

export async function entityTotal(
  strapi: Core.Strapi,
  config: EntityConfig,
  query: string,
  fallbackCache: FallbackRequestCache,
  locale = DEFAULT_CONTENT_LOCALE,
) {
  return withSearchMode(
    strapi,
    (connection) =>
      rankedTotal(
        connection,
        entityCountQuery(config.key, searchNeedles(query), locale),
      ),
    async () =>
      (await fallbackEntities(strapi, config, query, fallbackCache, locale)).length,
  );
}

// Returns mapped offer hits in ranked, paged order.
export async function offerPage(
  strapi: Core.Strapi,
  kind: OfferKind,
  query: string,
  window: PageWindow,
  fallbackCache: FallbackRequestCache,
  nowIso: string,
  locale = DEFAULT_CONTENT_LOCALE,
) {
  return withSearchMode(
    strapi,
    async (connection) => {
      const ids = await rankedDocumentIds(
        connection,
        offerRankedQuery(
          kind,
          searchNeedles(query),
          {
            limit: window.limit + (window.lookahead ?? 0),
            offset: window.offset,
          },
          nowIso,
          locale,
        ),
      );
      const documents = await hydrateByDocumentId(
        strapi,
        kind === "coupon" ? "api::coupon.coupon" : "api::deal.deal",
        ids,
        // Re-apply the same contentStatus/expiresAt visibility as the ranked
        // SQL WHERE while hydrating ranked ids.
        kind === "coupon"
          ? {
              fields: COUPON_FIELDS,
              populate: couponPopulate,
              visibility: publishedOnlyFilters(nowIso),
              locale,
            }
          : {
              fields: DEAL_FIELDS,
              populate: dealPopulate,
              visibility: publishedOnlyFilters(nowIso),
              locale,
            },
      );
      return documents
        .map((item) => mapOffer(item, kind))
        .filter(Boolean)
        .slice(0, window.limit);
    },
    async () => {
      const documents = await fallbackOffers(
        strapi,
        kind,
        query,
        fallbackCache,
        nowIso,
        locale,
      );
      const ranked = rankOfferDocuments(documents, kind, query);
      if (window.lookahead !== undefined) {
        return ranked
          .map((item) => mapOffer(item, kind))
          .filter(Boolean)
          .slice(0, window.limit);
      }
      return ranked
        .slice(window.offset, window.offset + window.limit)
        .map((item) => mapOffer(item, kind))
        .filter(Boolean);
    },
  );
}

export async function offerTotal(
  strapi: Core.Strapi,
  kind: OfferKind,
  query: string,
  fallbackCache: FallbackRequestCache,
  nowIso: string,
  locale = DEFAULT_CONTENT_LOCALE,
) {
  return withSearchMode(
    strapi,
    (connection) =>
      rankedTotal(
        connection,
        offerCountQuery(kind, searchNeedles(query), nowIso, locale),
      ),
    async () =>
      (await fallbackOffers(strapi, kind, query, fallbackCache, nowIso, locale)).length,
  );
}

export function emptyResponse(query: string): any {
  return {
    query,
    suggestions: [],
    stores: [],
    brands: [],
    categories: [],
    banks: [],
    coupons: [],
    deals: [],
    totals: {
      stores: 0,
      brands: 0,
      categories: 0,
      banks: 0,
      coupons: 0,
      deals: 0,
    },
    pagination: null,
    hasMore: {
      stores: false,
      brands: false,
      categories: false,
      banks: false,
      coupons: false,
      deals: false,
    },
    partialSources: [],
  };
}

export async function preview(
  strapi: Core.Strapi,
  request: SearchRequest,
  nowIso: string,
  // Feature-disabled kinds are skipped entirely: their records must not
  // surface as results linking into routes the storefront now 404s.
  liveKeys?: ReadonlySet<string>,
) {
  const isLive = (key: string) => liveKeys?.has(key) ?? true;
  const response = emptyResponse(request.query);
  const fallbackCache: FallbackRequestCache = new Map();
  const entityWindow = {
    limit: PREVIEW_ENTITY_LIMIT,
    offset: 0,
    lookahead: PREVIEW_BACKFILL,
  };
  const offerWindow = {
    limit: PREVIEW_OFFER_LIMIT,
    offset: 0,
    lookahead: PREVIEW_BACKFILL,
  };
  const [
    entityResults,
    couponItems,
    couponCount,
    dealItems,
    dealCount,
  ] = await Promise.all([
    Promise.all(
      ENTITIES.filter((config) => isLive(config.key)).map(async (config) => {
        const [items, total] = await Promise.all([
          entityPage(strapi, config, request.query, entityWindow, fallbackCache, request.locale),
          entityTotal(strapi, config, request.query, fallbackCache, request.locale),
        ]);
        return [config, items, total] as const;
      }),
    ),
    isLive("coupons")
      ? offerPage(
          strapi,
          "coupon",
          request.query,
          offerWindow,
          fallbackCache,
          nowIso,
          request.locale,
        )
      : Promise.resolve([]),
    isLive("coupons")
      ? offerTotal(strapi, "coupon", request.query, fallbackCache, nowIso, request.locale)
      : Promise.resolve(0),
    isLive("deals")
      ? offerPage(
          strapi,
          "deal",
          request.query,
          offerWindow,
          fallbackCache,
          nowIso,
          request.locale,
        )
      : Promise.resolve([]),
    isLive("deals")
      ? offerTotal(strapi, "deal", request.query, fallbackCache, nowIso, request.locale)
      : Promise.resolve(0),
  ]);

  for (const [config, items, total] of entityResults) {
    response[config.key] = items;
    response.totals[config.key] = total;
    response.hasMore[config.key] = total > PREVIEW_ENTITY_LIMIT;
  }

  response.coupons = couponItems.map(toPublicOffer);
  response.deals = dealItems.map(toPublicOffer);
  response.totals.coupons = couponCount;
  response.totals.deals = dealCount;
  response.hasMore.coupons = couponCount > PREVIEW_OFFER_LIMIT;
  response.hasMore.deals = response.totals.deals > PREVIEW_OFFER_LIMIT;

  const matchedName =
    response.stores[0]?.name ??
    response.brands[0]?.name ??
    response.categories[0]?.name ??
    response.banks[0]?.name ??
    request.query;
  // Generated suggestions are STRUCTURED: the storefront words them in the
  // page language through its UI dictionary (`kind` + `name`), so no language
  // is special-cased here. `label`/`query` carry the English wording only for
  // consumers that predate the structured shape.
  const candidates: { kind: string; name: string; suffix: string }[] = [
    { kind: "coupons", name: matchedName, suffix: " coupons" },
    { kind: "deals", name: matchedName, suffix: " deals" },
    { kind: "promoCodes", name: request.query, suffix: " promo codes" },
    { kind: "offers", name: request.query, suffix: " offers" },
  ];
  const seen = new Set<string>();
  response.suggestions = [];
  for (const candidate of candidates) {
    const name = normalizeQuery(candidate.name);
    const label = normalizeQuery(candidate.name + candidate.suffix);
    if (!name || seen.has(label)) continue;
    seen.add(label);
    response.suggestions.push({
      id: "suggestion-" + (response.suggestions.length + 1),
      kind: candidate.kind,
      name,
      label,
      query: label,
    });
  }

  return response;
}

export async function group(
  strapi: Core.Strapi,
  request: SearchRequest,
  nowIso: string,
  liveKeys?: ReadonlySet<string>,
) {
  const isLive = (key: string) => liveKeys?.has(key) ?? true;
  const response = emptyResponse(request.query);
  const fallbackCache: FallbackRequestCache = new Map();
  const window = {
    limit: request.pageSize,
    offset: (request.page - 1) * request.pageSize,
  };
  let total = 0;

  if (
    (request.group === "coupons" || request.group === "deals") &&
    isLive(request.group)
  ) {
    const [couponCount, dealCount] = await Promise.all([
      isLive("coupons")
        ? offerTotal(strapi, "coupon", request.query, fallbackCache, nowIso, request.locale)
        : Promise.resolve(0),
      isLive("deals")
        ? offerTotal(strapi, "deal", request.query, fallbackCache, nowIso, request.locale)
        : Promise.resolve(0),
    ]);
    response.totals.coupons = couponCount;
    response.totals.deals = dealCount;

    if (request.group === "coupons") {
      const items = await offerPage(
        strapi,
        "coupon",
        request.query,
        window,
        fallbackCache,
        nowIso,
        request.locale,
      );
      response.coupons = items.map(toPublicOffer);
      total = couponCount;
    } else {
      const items = await offerPage(
        strapi,
        "deal",
        request.query,
        window,
        fallbackCache,
        nowIso,
        request.locale,
      );
      response.deals = items.map(toPublicOffer);
      total = dealCount;
    }
  } else {
    const config = ENTITIES.find(
      (item) => item.key === request.group && isLive(item.key),
    );
    if (config) {
      const [items, entityCount] = await Promise.all([
        entityPage(strapi, config, request.query, window, fallbackCache, request.locale),
        entityTotal(strapi, config, request.query, fallbackCache, request.locale),
      ]);
      response[config.key] = items;
      response.totals[config.key] = entityCount;
      total = entityCount;
    }
  }

  // page is clamped to MAX_PAGE in parseRequest; advertise only reachable
  // pages so hasMore goes false at the clamp instead of looping forever.
  const pageCount = Math.min(Math.ceil(total / request.pageSize), MAX_PAGE);
  response.pagination = {
    group: request.group,
    page: request.page,
    pageSize: request.pageSize,
    pageCount,
    total,
  };
  if (request.group) {
    response.hasMore[request.group] = request.page < pageCount;
  }
  return response;
}
