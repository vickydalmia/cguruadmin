import type { Core } from '@strapi/strapi';
import {
  CSV_EXPORT_TARGETS,
  type CsvExportPage,
  type CsvExportUid,
} from '../../../constants/csv-export';
import {
  buildColumns,
  buildPopulate,
  type ModelResolver,
} from './csv-export-columns';
import { csvHeader, csvRow, flattenEntry } from './csv-export-format';
import {
  resolveAdminEmails,
  resolveMerchantNames,
} from './csv-export-loaders';


/**
 * CSV export service — turns one page of a collection type into CSV text.
 *
 * EVERYTHING IS DERIVED FROM THE SCHEMA, NOT FROM THE DATA. The admin fetches
 * pages one at a time, so the column set must be identical on every page and
 * known before any row is read; `buildColumns` walks the content-type schema
 * (and the component schemas it references) and `flattenEntry` reads each
 * column's path back out of a populated document. A row with every relation
 * empty and a row with fifty still produce the same header.
 *
 * Flattening rules, one per attribute kind (see `Column.kind`):
 *   - scalars          → the value as text; dates ISO-8601, booleans true/false
 *   - json / dynamiczone / repeatable component → one JSON column (lossless)
 *   - relation         → `<field>`: the related rows' names/titles, " | "-joined
 *                        in join order (orderedCoupons keeps its order). No
 *                        documentId columns — editors read names, not ids.
 *   - media            → `<field>.url`, `<field>.name`, `<field>.alternativeText`
 *   - single component → recursive `<field>.<attr>` columns
 *   - createdBy/updatedBy → "First Last <email>"
 *   - checkoutMerchant → the merchant's name with its kind, "Amazon (store)";
 *                        the raw `<kind>:<documentId>` only when unresolvable
 *
 * The populate is built from the same walk and deliberately selects only the
 * display fields of related rows: content-manager's getDeepPopulate would
 * drag five full Store rows (descriptions included) into every Coupon.
 */

//
// Column definitions live in ./csv-export-columns, value formatting and
// escaping in ./csv-export-format, and the per-page context loaders in
// ./csv-export-loaders. This file exposes exactly exportPage and targets.

export type ExportPageParams = {
  uid: CsvExportUid;
  page: number;
  pageSize: number;
};

/**
 * One page of the export. `sort: id:asc` keeps page boundaries stable while
 * the admin walks the pages: an entry created mid-export lands at the end, a
 * deletion shifts one row — both acceptable for a snapshot taken while
 * editors may still be working.
 */
export async function exportPage(
  strapi: Core.Strapi,
  { uid, page, pageSize }: ExportPageParams,
): Promise<CsvExportPage> {
  const getModel: ModelResolver = (modelUid) => strapi.getModel(modelUid as any);
  const columns = buildColumns(uid, getModel);
  const populate = buildPopulate(uid, getModel);
  const start = (page - 1) * pageSize;

  const [rows, total] = await Promise.all([
    strapi.documents(uid as any).findMany({
      start,
      limit: pageSize,
      sort: 'id:asc',
      populate: populate === true ? undefined : populate,
    } as any) as Promise<any[]>,
    strapi.documents(uid as any).count({} as any) as Promise<number>,
  ]);

  const entries = Array.isArray(rows) ? rows : [];
  const hasMerchant = columns.some((column) => column.kind === 'merchant');
  const [merchantNames, adminEmails] = await Promise.all([
    hasMerchant ? resolveMerchantNames(strapi, entries) : undefined,
    resolveAdminEmails(strapi, columns, entries),
  ]);

  const lines = entries
    .map((entry) =>
      csvRow(flattenEntry(columns, entry, { merchantNames, adminEmails })),
    )
    .join('');

  const safeTotal = Number.isFinite(Number(total)) ? Number(total) : entries.length;
  return {
    uid,
    page,
    pageSize,
    total: safeTotal,
    pageCount: Math.max(1, Math.ceil(safeTotal / pageSize)),
    header: csvHeader(columns),
    lines,
    rowCount: entries.length,
  };
}

export function createCsvExportService({ strapi }: { strapi: Core.Strapi }) {
  return {
    exportPage: (params: ExportPageParams) => exportPage(strapi, params),
    targets: CSV_EXPORT_TARGETS,
  };
}

export default createCsvExportService;
