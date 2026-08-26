import type { Core } from '@strapi/strapi';
import {
  CSV_EXPORT_MAX_PAGE_SIZE,
  CSV_EXPORT_TARGETS,
  isCsvExportUid,
  type CsvExportUid,
} from '../../../constants/csv-export';

export type ParsedExportQuery =
  | { ok: true; uid: CsvExportUid; page: number; pageSize: number }
  | { ok: false; status: 400 | 404; message: string };

function positiveInteger(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return Number.NaN;
  return parsed;
}

/**
 * Validate the route param and query string. Exported so the rules are
 * unit-tested without a Koa context: unknown uid → 404, non-integer or
 * out-of-range paging → 400, missing pageSize → the target's default.
 */
export function parseExportQuery(
  rawUid: unknown,
  query: Record<string, unknown> | undefined,
): ParsedExportQuery {
  if (!isCsvExportUid(rawUid)) {
    return { ok: false, status: 404, message: 'Unknown export target' };
  }
  const uid = rawUid;

  const page = positiveInteger(query?.page) ?? 1;
  if (Number.isNaN(page)) {
    return { ok: false, status: 400, message: 'page must be a positive integer' };
  }

  const pageSize = positiveInteger(query?.pageSize) ?? CSV_EXPORT_TARGETS[uid].pageSize;
  if (Number.isNaN(pageSize) || pageSize > CSV_EXPORT_MAX_PAGE_SIZE) {
    return {
      ok: false,
      status: 400,
      message: `pageSize must be an integer between 1 and ${CSV_EXPORT_MAX_PAGE_SIZE}`,
    };
  }

  return { ok: true, uid, page, pageSize };
}

// Mounted on the ADMIN router (src/register/admin-routes.ts) behind
// admin::isAuthenticatedAdmin + global::super-admin-only: the export carries
// every field of every entry, so it is a Super Admin tool by decision, not a
// per-role capability. The button in the admin hides itself for other roles,
// but the policy is what actually enforces it.
export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async page(ctx: any) {
    const parsed = parseExportQuery(ctx.params?.uid, ctx.query);
    if (parsed.ok === false) {
      return parsed.status === 404
        ? ctx.notFound(parsed.message)
        : ctx.badRequest(parsed.message);
    }

    const service = strapi.service('api::csv-export.csv-export') as any;
    const result = await service.exportPage({
      uid: parsed.uid,
      page: parsed.page,
      pageSize: parsed.pageSize,
    });
    return ctx.send(result);
  },
});
