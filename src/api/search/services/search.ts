import type { Core } from "@strapi/strapi";
import { parseRequest, type SearchRequest } from "./search-request";
import { group, preview } from "./search-results";
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

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  parseRequest,
  status() {
    return searchRuntimeStatus(strapi);
  },
  async search(request: SearchRequest) {
    const nowIso = new Date().toISOString();
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
          ? group(strapi, request, nowIso)
          : preview(strapi, request, nowIso),
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
