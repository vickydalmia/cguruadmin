// CSV export VALUE FORMATTING & ESCAPING: scalar/relation flattening, the
// audit-user rendering, and the quoting/formula-injection rules. One of the
// modules split out of the csv-export service (see ./csv-export.ts). CRLF
// and the escaping rules are the wire contract — do not vary per caller.
import { parseCheckoutMerchant } from '../../../constants/checkout-merchant';
import { type Column } from './csv-export-columns';

const MANY_SEPARATOR = ' | ';

const CRLF = '\r\n';

export function readPath(entry: any, path: string[]): unknown {
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
