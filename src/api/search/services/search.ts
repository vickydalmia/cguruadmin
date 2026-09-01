import type { Core } from "@strapi/strapi";
import { parseRequest, type SearchRequest } from "./search-request";
import { group, preview } from "./search-results";
import { cachedSiteConfiguration } from "../../site-configuration/services/cached-configuration";
import type { FeatureField } from "../../site-configuration/services/country-registry";
import {
  SEARCH_SLOW_LOG_MS,
  searchPhaseStorage,
  type SearchPhaseStats,
} from "./search-postgres";
import { searchRuntimeStatus } from "./search-runtime";

// The thin search service: request parsing lives in ./search-request, the
// entity registry and projections in ./search-config, normalisation and
// ranking in ./search-ranking, the query-engine fallback in
// ./search-fallback, ranked SQL execution in ./search-postgres, runtime mode
// and diagnostics in ./search-runtime, and response composition in
// ./search-results. This file exposes exactly parseRequest, status and
// search.

// Search only covers catalog kinds, whose feature readiness is "records
// exist" — so the configured flag alone decides visibility here: a disabled
// kind's records must not surface as results that link into 404 routes.
const SEARCH_KEY_FLAGS: Readonly<Record<string, FeatureField>> = {
  stores: 'storesEnabled',
  brands: 'brandsEnabled',
  categories: 'categoriesEnabled',
  banks: 'banksEnabled',
  coupons: 'couponsEnabled',
  deals: 'productDealsEnabled',
};

async function liveSearchKeys(strapi: Core.Strapi): Promise<ReadonlySet<string>> {
  const config = await cachedSiteConfiguration(strapi);
  return new Set(
    Object.entries(SEARCH_KEY_FLAGS)
      .filter(([, flag]) => config[flag] === true)
      .map(([key]) => key),
  );
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  parseRequest,
  status() {
    return searchRuntimeStatus(strapi);
  },
  async search(request: SearchRequest) {
    const nowIso = new Date().toISOString();
    const liveKeys = await liveSearchKeys(strapi);
    const stats: SearchPhaseStats = {
      sql: 0,
      sqlCalls: 0,
      hydrate: 0,
      hydrateCalls: 0,
    };
    const startedAt = Date.now();
    try {
      return await searchPhaseStorage.run(stats, () =>
        request.mode === "group"
          ? group(strapi, request, nowIso, liveKeys)
          : preview(strapi, request, nowIso, liveKeys),
      );
    } finally {
      const totalMs = Date.now() - startedAt;
      if (SEARCH_SLOW_LOG_MS > 0 && totalMs >= SEARCH_SLOW_LOG_MS) {
        (strapi as any).log?.info?.(
          `[search] slow ${request.mode} total=${totalMs}ms ` +
            `sql=${stats.sql}ms/${stats.sqlCalls}q ` +
            `hydrate=${stats.hydrate}ms/${stats.hydrateCalls}q ` +
            "(phase sums are concurrent busy-time, not wall time)",
        );
      }
    }
  },
});
