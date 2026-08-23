import type { getFetchClient } from '@strapi/strapi/admin';

import {
  CSV_EXPORT_ROUTE_PREFIX,
  CSV_EXPORT_TARGETS,
  isCsvExportUid,
  type CsvExportPage,
  type CsvExportUid,
} from '../../../constants/csv-export';

/**
 * Everything behind the "Export CSV" modal that is worth testing, kept
 * React-free: the page loop, the progress arithmetic, the file assembly and
 * the error wording. `use-csv-export.ts` only adapts this to component state
 * and `components/csv-export-button.tsx` only renders it.
 */

/**
 * Exactly the `get` the admin fetch client exposes, borrowed as a type so the
 * tests can pass a two-line double (same trick as checkout-merchant's
 * merchant-options.ts). `getFetchClient`, not the hook: the hook aborts its
 * in-flight request when the component unmounts, and this loop outlives any
 * single render.
 */
export type ExportFetchClient = Pick<ReturnType<typeof getFetchClient>, 'get'>;

export const SUPER_ADMIN_ROLE_CODE = 'strapi-super-admin';

/** Mirrors the server policy (`global::super-admin-only`) for the button. */
export function isSuperAdminUser(user: unknown): boolean {
  const roles = (user as any)?.roles;
  return (
    Array.isArray(roles) &&
    roles.some((role: any) => role?.code === SUPER_ADMIN_ROLE_CODE)
  );
}

export function exportPagePath(uid: CsvExportUid, page: number, pageSize: number): string {
  const query = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  return `${CSV_EXPORT_ROUTE_PREFIX}/${encodeURIComponent(uid)}?${query.toString()}`;
}

/**
 * The admin router returns the page object directly, but read through the
 * same `data.data ?? data` envelope the rest of the admin uses so a future
 * wrapper cannot silently break the loop. Throws on anything that does not
 * look like a page, so a proxy error page never becomes "0 rows exported".
 */
export function unwrapPage(response: unknown): CsvExportPage {
  const body: any = (response as any)?.data?.data ?? (response as any)?.data ?? response;
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.header !== 'string' ||
    typeof body.lines !== 'string' ||
    !Number.isFinite(Number(body.total)) ||
    !Number.isFinite(Number(body.pageCount))
  ) {
    throw new Error('The export endpoint returned an unexpected response.');
  }
  return {
    ...body,
    total: Number(body.total),
    pageCount: Math.max(1, Number(body.pageCount)),
    rowCount: Number.isFinite(Number(body.rowCount)) ? Number(body.rowCount) : 0,
  };
}

/** `coupons-2026-08-23.csv` — the date is the viewer's local calendar day. */
export function exportFileName(uid: CsvExportUid, date: Date): string {
  const stem = CSV_EXPORT_TARGETS[uid].fileStem;
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${stem}-${yyyy}-${mm}-${dd}.csv`;
}

/** Whole percent, never above 100, 0 while nothing is known yet. */
export function progressPercent(done: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return done > 0 ? 100 : 0;
  return Math.min(100, Math.max(0, Math.floor((done / total) * 100)));
}

/** UTF-8 BOM so Excel opens the file as UTF-8 instead of mangling it. */
export const CSV_BOM = '\ufeff';

/** The complete file: BOM, the header once, then every page in order. */
export function assembleCsv(header: string, chunks: readonly string[]): string {
  return CSV_BOM + header + chunks.join('');
}

export function csvBlob(text: string): Blob {
  return new Blob([text], { type: 'text/csv;charset=utf-8' });
}

export type ExportProgress = {
  /** Rows received so far. */
  done: number;
  /** Total rows, known after page 1 (0 before). */
  total: number;
  percent: number;
  page: number;
  pageCount: number;
};

export type ExportResult = {
  fileName: string;
  rows: number;
  text: string;
};

export function isAbortError(error: unknown): boolean {
  return (
    (error as any)?.name === 'AbortError' ||
    (error as any)?.code === 'ERR_CANCELED' ||
    /abort/i.test(String((error as any)?.message ?? ''))
  );
}

/** Editor-facing wording for a failed page request. */
export function exportErrorMessage(error: unknown, uid: CsvExportUid): string {
  const status = Number((error as any)?.status ?? (error as any)?.response?.status);
  const label = isCsvExportUid(uid) ? CSV_EXPORT_TARGETS[uid].label : 'this list';
  if (status === 401 || status === 403) {
    return `Only a Super Admin can export ${label}.`;
  }
  const message =
    (error as any)?.response?.data?.error?.message ??
    (error as any)?.message ??
    '';
  return message ? String(message) : 'The export failed. Please try again.';
}

/**
 * Walk every page of one export, reporting progress after each, and return
 * the assembled file. Sequential on purpose: one in-flight request keeps the
 * server load flat and makes the percentage monotonic. A cancelled signal
 * rejects with the fetch client's AbortError (see `isAbortError`).
 */
export async function runCsvExport(
  client: ExportFetchClient,
  uid: CsvExportUid,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ExportProgress) => void;
    now?: () => Date;
    pageSize?: number;
  } = {},
): Promise<ExportResult> {
  const pageSize = options.pageSize ?? CSV_EXPORT_TARGETS[uid].pageSize;
  const chunks: string[] = [];
  let header = '';
  let done = 0;
  let total = 0;
  let pageCount = 1;

  for (let page = 1; page <= pageCount; page += 1) {
    if (options.signal?.aborted) {
      const abort = new Error('Export cancelled');
      abort.name = 'AbortError';
      throw abort;
    }
    const response = await client.get(exportPagePath(uid, page, pageSize), {
      signal: options.signal,
    });
    const body = unwrapPage(response);
    if (page === 1) {
      header = body.header;
      total = body.total;
      pageCount = body.pageCount;
    }
    chunks.push(body.lines);
    done += body.rowCount;
    options.onProgress?.({
      done,
      total,
      percent: progressPercent(done, total),
      page,
      pageCount,
    });
    // A shrinking collection can end early; never loop past the data.
    if (body.rowCount === 0 && page < pageCount) break;
  }

  return {
    fileName: exportFileName(uid, (options.now ?? (() => new Date()))()),
    rows: done,
    text: assembleCsv(header, chunks),
  };
}
