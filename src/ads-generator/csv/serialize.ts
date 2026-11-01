import { GOOGLE_ADS_CSV_COLUMNS } from './columns';
import type { CsvRow } from './build-rows';

/**
 * Google Ads web-upload CSV: UTF-8 BOM, CRLF line endings, the fixed 97
 * headers, RFC 4180 quoting. A value that would start a spreadsheet formula
 * is refused rather than silently altered: the form and creative validators
 * are expected to have rejected it already.
 */

const BOM = '﻿';
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function serializeCsv(rows: CsvRow[]): string {
  const lines = [GOOGLE_ADS_CSV_COLUMNS.map(escapeCell).join(',')];
  for (const row of rows) {
    const unknown = Object.keys(row).filter((key) => !(GOOGLE_ADS_CSV_COLUMNS as readonly string[]).includes(key));
    if (unknown.length) throw new Error(`Unknown CSV columns: ${unknown.join(', ')}`);
    lines.push(GOOGLE_ADS_CSV_COLUMNS.map((column) => escapeCell(row[column] ?? '')).join(','));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

function escapeCell(value: string): string {
  if (FORMULA_PREFIX.test(value)) throw new Error(`Unsafe CSV value: ${value.slice(0, 30)}`);
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
