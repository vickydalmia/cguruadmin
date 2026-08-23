import type { Core } from '@strapi/strapi';
import {
  CHECKOUT_MERCHANT_FIELD,
  parseCheckoutMerchant,
} from '../../../constants/checkout-merchant';
import {
  CSV_EXPORT_TARGETS,
  type CsvExportPage,
  type CsvExportUid,
} from '../../../constants/csv-export';

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

export type ColumnKind =
  | 'scalar'
  | 'json'
  | 'relation'
  | 'media'
  | 'audit-user'
  | 'merchant';

export type Column = {
  /** CSV header cell. */
  header: string;
  /** Path into the populated document, e.g. ['seo', 'metaTitle']. */
  path: string[];
  kind: ColumnKind;
  /** relation: the attribute on the related row to display. */
  displayField?: string;
  /** media: which file attribute this column carries. */
  mediaField?: 'url' | 'name' | 'alternativeText';
};

/** Resolves a content-type or component uid to its loaded schema. */
export type ModelResolver = (uid: string) => any;

const MANY_SEPARATOR = ' | ';
const CRLF = '\r\n';
const ADMIN_USER_UID = 'admin::user';
const MEDIA_FIELDS = ['url', 'name', 'alternativeText'] as const;
const ADMIN_USER_FIELDS = ['firstname', 'lastname', 'username'];

/**
 * Attributes Strapi adds to every content type at load time. They are walked
 * explicitly, in this order, AFTER the schema's own attributes so the audit
 * trail always sits in the last columns regardless of where the loader put
 * them. `localizations` is omitted: none of the exported types is localized
 * and the self-relation would only ever hold the row itself.
 */
const TRAILING_ATTRIBUTES = [
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  'locale',
] as const;
const SKIPPED_ATTRIBUTES = new Set<string>([...TRAILING_ATTRIBUTES, 'localizations']);

const DISPLAY_FIELD_BY_UID: Record<string, string> = {
  'api::coupon.coupon': 'title',
  'api::deal.deal': 'title',
  [ADMIN_USER_UID]: 'email',
};

export function relationDisplayField(targetUid: string): string {
  return DISPLAY_FIELD_BY_UID[targetUid] ?? 'name';
}

function attributesOf(model: any): Array<[string, any]> {
  const attributes = model?.attributes;
  if (!attributes || typeof attributes !== 'object') return [];
  return Object.entries(attributes);
}

function isCheckoutMerchantAttribute(name: string, attribute: any): boolean {
  return name === CHECKOUT_MERCHANT_FIELD && attribute?.type === 'customField';
}

function columnsForAttribute(
  name: string,
  attribute: any,
  prefix: string[],
  getModel: ModelResolver,
  depth: number,
): Column[] {
  const path = [...prefix, name];
  const header = path.join('.');
  switch (attribute?.type) {
    case 'password':
      return [];
    case 'relation': {
      const target = String(attribute.target ?? '');
      if (target === ADMIN_USER_UID) {
        return [{ header, path, kind: 'audit-user' }];
      }
      return [{ header, path, kind: 'relation', displayField: relationDisplayField(target) }];
    }
    case 'media':
      return MEDIA_FIELDS.map((mediaField) => ({
        header: `${header}.${mediaField}`,
        path,
        kind: 'media' as const,
        mediaField,
      }));
    case 'component': {
      // Repeatable components and anything nested too deep become one JSON
      // cell: a row-per-entry CSV cannot represent a list of objects as
      // columns without inventing a fixed count.
      if (attribute.repeatable || depth >= 3) {
        return [{ header, path, kind: 'json' }];
      }
      const component = getModel(String(attribute.component ?? ''));
      if (!component) return [{ header, path, kind: 'json' }];
      return attributesOf(component).flatMap(([childName, child]) =>
        columnsForAttribute(childName, child, path, getModel, depth + 1),
      );
    }
    case 'dynamiczone':
    case 'json':
      return [{ header, path, kind: 'json' }];
    case 'customField':
      if (isCheckoutMerchantAttribute(name, attribute) && prefix.length === 0) {
        return [{ header, path, kind: 'merchant' }];
      }
      return [{ header, path, kind: 'scalar' }];
    default:
      return [{ header, path, kind: 'scalar' }];
  }
}

/**
 * The ordered column list for a content type: id, documentId, the schema's
 * own attributes in declaration order, then the audit/lifecycle attributes.
 */
export function buildColumns(uid: string, getModel: ModelResolver): Column[] {
  const model = getModel(uid);
  if (!model) throw new Error(`csv-export: unknown model ${uid}`);

  const columns: Column[] = [
    { header: 'id', path: ['id'], kind: 'scalar' },
    { header: 'documentId', path: ['documentId'], kind: 'scalar' },
  ];

  for (const [name, attribute] of attributesOf(model)) {
    if (SKIPPED_ATTRIBUTES.has(name)) continue;
    columns.push(...columnsForAttribute(name, attribute, [], getModel, 0));
  }

  for (const name of TRAILING_ATTRIBUTES) {
    const attribute = model.attributes?.[name];
    if (!attribute) continue;
    columns.push(...columnsForAttribute(name, attribute, [], getModel, 0));
  }

  return columns;
}

/**
 * Populate object matching `buildColumns`: related rows contribute only
 * their display field and documentId, media only the three file attributes,
 * components recurse. Returns `true` for a schema with nothing to populate so
 * a component of plain scalars is still loaded.
 */
export function buildPopulate(
  uid: string,
  getModel: ModelResolver,
  depth = 0,
): Record<string, any> | true {
  const model = getModel(uid);
  if (!model) return true;

  const populate: Record<string, any> = {};
  for (const [name, attribute] of attributesOf(model)) {
    if (name === 'localizations') continue;
    switch (attribute?.type) {
      case 'relation': {
        const target = String(attribute.target ?? '');
        // admin::user.email is `private`, and the document service validates a
        // populate's nested `fields` with the private-field rule ("Invalid key
        // email"). Populate the name parts only; emails are resolved per page
        // through strapi.db.query (resolveAdminEmails), which also keeps the
        // password hash and reset tokens out of the loaded rows.
        populate[name] =
          target === ADMIN_USER_UID
            ? { fields: ADMIN_USER_FIELDS }
            : { fields: [relationDisplayField(target), 'documentId'] };
        break;
      }
      case 'media':
        populate[name] = { fields: [...MEDIA_FIELDS] };
        break;
      case 'component': {
        // A nested `populate: true` is rejected by the query converter
        // ("Expected a string, an array of strings, a populate object"); a
        // component of plain scalars is loaded by setting the component
        // itself to true.
        const nested =
          depth >= 3
            ? true
            : buildPopulate(String(attribute.component ?? ''), getModel, depth + 1);
        populate[name] = nested === true ? true : { populate: nested };
        break;
      }
      case 'dynamiczone':
        populate[name] = true;
        break;
      default:
        break;
    }
  }
  return Object.keys(populate).length ? populate : true;
}

function readPath(entry: any, path: string[]): unknown {
  let current: any = entry;
  for (const key of path) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function asList(value: unknown): any[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function auditUser(value: unknown, emails?: Map<number, string>): string {
  const user: any = value;
  if (!user || typeof user !== 'object') return '';
  const fullName = [user.firstname, user.lastname]
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')
    .trim();
  const email =
    (typeof user.email === 'string' && user.email) ||
    emails?.get(Number(user.id)) ||
    '';
  if (fullName && email) return `${fullName} <${email}>`;
  return fullName || email || (user.username ?? '') || '';
}

export type FlattenContext = {
  /** `<kind>:<documentId>` → merchant name, for the checkoutMerchant column. */
  merchantNames?: Map<string, string>;
  /** admin user id → email, for the createdBy/updatedBy columns. */
  adminEmails?: Map<number, string>;
};

/** One CSV row (unescaped cell values) for a populated document. */
export function flattenEntry(
  columns: Column[],
  entry: any,
  context: FlattenContext = {},
): string[] {
  return columns.map((column) => {
    const value = readPath(entry, column.path);
    switch (column.kind) {
      case 'scalar':
        return formatScalar(value);
      case 'json':
        return value === null || value === undefined ? '' : JSON.stringify(value);
      case 'relation':
        return asList(value)
          .map((related) =>
            formatScalar(related?.[column.displayField ?? 'name'] ?? related?.documentId),
          )
          .join(MANY_SEPARATOR);
      case 'media':
        return asList(value)
          .map((file) => formatScalar(file?.[column.mediaField ?? 'url']))
          .join(MANY_SEPARATOR);
      case 'audit-user':
        return auditUser(value, context.adminEmails);
      case 'merchant': {
        const key = typeof value === 'string' ? value.trim() : '';
        if (!key) return '';
        const ref = parseCheckoutMerchant(key);
        const name = context.merchantNames?.get(key);
        // A reference nobody can resolve (merchant deleted) still exports as
        // the raw reference rather than vanishing.
        return ref && name ? `${name} (${ref.kind})` : key;
      }
      default:
        return formatScalar(value);
    }
  });
}

const NEEDS_QUOTING = /[",\r\n]/;
const FORMULA_LEAD = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * RFC 4180 cell: quote when the value holds a comma, quote or line break,
 * doubling embedded quotes. Values that a spreadsheet would evaluate as a
 * formula (leading = + - @, tab, CR) are prefixed with an apostrophe — the
 * standard CSV-injection guard — unless they are a plain number such as -5.
 */
export function csvCell(value: string): string {
  let text = value;
  if (FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text)) {
    text = `'${text}`;
  }
  if (NEEDS_QUOTING.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** A CRLF-terminated CSV line. */
export function csvRow(values: string[]): string {
  return values.map(csvCell).join(',') + CRLF;
}

export function csvHeader(columns: Column[]): string {
  return csvRow(columns.map((column) => column.header));
}

/**
 * Resolve every `<kind>:<documentId>` reference on this page to a merchant
 * name with one query per kind. Unknown references (a merchant deleted after
 * the offer was saved) resolve to an empty name; the raw column still shows
 * the reference.
 */
export async function resolveMerchantNames(
  strapi: Core.Strapi,
  rows: any[],
): Promise<Map<string, string>> {
  const ids: Record<'store' | 'brand', Set<string>> = {
    store: new Set(),
    brand: new Set(),
  };
  for (const row of rows) {
    const ref = parseCheckoutMerchant(row?.[CHECKOUT_MERCHANT_FIELD]);
    if (ref) ids[ref.kind].add(ref.documentId);
  }

  const names = new Map<string, string>();
  for (const kind of ['store', 'brand'] as const) {
    const documentIds = [...ids[kind]];
    if (!documentIds.length) continue;
    const found: any[] = await strapi
      .documents(`api::${kind}.${kind}` as any)
      .findMany({
        filters: { documentId: { $in: documentIds } },
        fields: ['documentId', 'name'],
        limit: documentIds.length,
      } as any);
    for (const merchant of found ?? []) {
      if (merchant?.documentId) {
        names.set(`${kind}:${merchant.documentId}`, String(merchant.name ?? ''));
      }
    }
  }
  return names;
}

/**
 * Emails for every admin user referenced by an audit column on this page,
 * in one query. `email` is private on admin::user, so it cannot be selected
 * through the document-service populate (see buildPopulate); the Query Engine
 * has no such rule.
 */
export async function resolveAdminEmails(
  strapi: Core.Strapi,
  columns: Column[],
  rows: any[],
): Promise<Map<number, string>> {
  const ids = new Set<number>();
  const userColumns = columns.filter((column) => column.kind === 'audit-user');
  for (const row of rows) {
    for (const column of userColumns) {
      const id = Number((readPath(row, column.path) as any)?.id);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
  }
  const emails = new Map<number, string>();
  if (!ids.size) return emails;
  const users: any[] = await strapi.db.query(ADMIN_USER_UID as any).findMany({
    where: { id: { $in: [...ids] } },
    select: ['id', 'email'],
  } as any);
  for (const user of users ?? []) {
    if (user?.id !== undefined && typeof user.email === 'string') {
      emails.set(Number(user.id), user.email);
    }
  }
  return emails;
}

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
