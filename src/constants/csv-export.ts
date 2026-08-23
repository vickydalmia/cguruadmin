/**
 * CSV export — the collection types an editor can download in full from the
 * Content Manager list view, and the paging contract the admin loop and the
 * server endpoint share.
 *
 * Shared by BOTH halves of the app (the admin bundle renders the button and
 * drives the page loop; the server validates the uid and page size), which is
 * why it lives in src/constants like checkout-merchant and record-lock.
 *
 * The export is paged on purpose: the admin fetches one page at a time so it
 * can show an exact percentage and cancel, and the server never has to hold
 * a 25k-row CSV in memory. Page 1 of every export carries the total, so the
 * percentage is exact from the first tick.
 */

export type CsvExportTarget = {
  /** Human label for the modal title ("Export Coupons to CSV"). */
  label: string;
  /** File name stem; the download is `<fileStem>-<yyyy-mm-dd>.csv`. */
  fileStem: string;
  /**
   * Rows per request. Offers are flat rows with one rich-text field; entity
   * rows carry relation lists (every linked coupon title) and SEO components,
   * so they page smaller to keep each response around a megabyte.
   */
  pageSize: number;
};

export const CSV_EXPORT_TARGETS = {
  'api::coupon.coupon': { label: 'Coupons', fileStem: 'coupons', pageSize: 250 },
  'api::deal.deal': { label: 'Product Deals', fileStem: 'deals', pageSize: 250 },
  'api::store.store': { label: 'Stores', fileStem: 'stores', pageSize: 100 },
  'api::brand.brand': { label: 'Brands', fileStem: 'brands', pageSize: 100 },
  'api::category.category': {
    label: 'Categories',
    fileStem: 'categories',
    pageSize: 100,
  },
  'api::bank.bank': { label: 'Banks', fileStem: 'banks', pageSize: 100 },
} as const satisfies Record<string, CsvExportTarget>;

export type CsvExportUid = keyof typeof CSV_EXPORT_TARGETS;

export function isCsvExportUid(uid: unknown): uid is CsvExportUid {
  return (
    typeof uid === 'string' &&
    Object.prototype.hasOwnProperty.call(CSV_EXPORT_TARGETS, uid)
  );
}

/** Hard ceiling on `pageSize`, whatever the client asks for. */
export const CSV_EXPORT_MAX_PAGE_SIZE = 500;

/**
 * Admin-router prefix. The admin router mounts with no prefix, so the page
 * endpoint serves at `/csv-export/:uid` — no /api segment (see
 * src/register/admin-routes.ts for why these cannot live under src/api routes).
 */
export const CSV_EXPORT_ROUTE_PREFIX = '/csv-export';

/** One page of an export, as the server returns it. */
export type CsvExportPage = {
  uid: CsvExportUid;
  page: number;
  pageSize: number;
  /** Total matching entries — constant across pages of one export. */
  total: number;
  pageCount: number;
  /** Header line, CRLF-terminated, without a BOM. Identical on every page. */
  header: string;
  /** This page's rows, each CRLF-terminated, concatenated. No BOM, no header. */
  lines: string;
  /** Rows in `lines`. */
  rowCount: number;
};
