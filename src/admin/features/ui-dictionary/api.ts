// Client for the /ui-dictionary admin endpoints. They live on the ADMIN
// router, so there is no /api prefix; useFetchClient attaches the session.
import type {
  ExportPayload,
  ImportResult,
  UiDictionaryEntry,
  UiDictionaryStatus,
} from './types';

const BASE = '/ui-dictionary';

export function statusPath(): string {
  return `${BASE}/status`;
}

export function entriesPath(locale: string, includeRemoved: boolean): string {
  const params = new URLSearchParams({ locale });
  if (includeRemoved) params.set('includeRemoved', '1');
  return `${BASE}/entries?${params.toString()}`;
}

/** Keys are dotted (`offers.count.other`); encode so a stray `/` or `%` cannot break the path. */
export function entryPath(locale: string, key: string): string {
  return `${BASE}/entries/${encodeURIComponent(locale)}/${encodeURIComponent(key)}`;
}

export function importPath(): string {
  return `${BASE}/import`;
}

export function exportPath(locale: string): string {
  return `${BASE}/export?${new URLSearchParams({ locale }).toString()}`;
}

export function translatePath(): string {
  return `${BASE}/translate`;
}

function unwrapData(response: unknown): any {
  return (response as any)?.data?.data ?? (response as any)?.data ?? response;
}

export function unwrapStatus(response: unknown): UiDictionaryStatus {
  const value = unwrapData(response);
  if (!value || typeof value !== 'object' || !Array.isArray(value.languages)) {
    throw new Error('UI Text status returned an unexpected response.');
  }
  return value as UiDictionaryStatus;
}

export function unwrapEntries(response: unknown): UiDictionaryEntry[] {
  const value = unwrapData(response);
  if (!value || !Array.isArray(value.entries)) {
    throw new Error('UI Text entries returned an unexpected response.');
  }
  return value.entries as UiDictionaryEntry[];
}

export function unwrapExport(response: unknown): ExportPayload {
  const value = unwrapData(response);
  if (!value || typeof value.locale !== 'string' || typeof value.messages !== 'object') {
    throw new Error('UI Text export returned an unexpected response.');
  }
  return value as ExportPayload;
}

export function unwrapImportResult(response: unknown): ImportResult {
  const value = unwrapData(response);
  if (!value || typeof value.written !== 'number' || !Array.isArray(value.skipped)) {
    throw new Error('UI Text import returned an unexpected response.');
  }
  return value as ImportResult;
}

/** The controller answers `{ error, details? }`; Strapi's own errors nest under error.message. */
export function uiDictionaryError(error: any): string {
  const payload = error?.response?.data?.error;
  if (typeof payload === 'string') return payload;
  return payload?.message ?? error?.message ?? 'UI Text request failed.';
}

export function isPermissionError(error: any): boolean {
  const status = error?.response?.status;
  return status === 401 || status === 403;
}

/**
 * `SearchInput` percent-encodes before writing `_q`, so the value read back
 * out is still encoded. Decode defensively — a malformed escape in a
 * hand-edited URL must not throw during render.
 */
export function parseSearch(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Parse pasted/uploaded JSON into `{ key: text }`. Accepts the bare map and
 * the export envelope (`{ locale, messages }`) so an export re-imports as is.
 */
export function parseImportJson(text: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON.');
  }
  const candidate =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'messages' in (parsed as any)
      ? (parsed as any).messages
      : parsed;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('Expected an object of { "key": "text" }.');
  }
  const messages: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (typeof value !== 'string') throw new Error(`"${key}" must be a string.`);
    messages[key] = value;
  }
  if (Object.keys(messages).length === 0) throw new Error('The JSON has no keys.');
  return messages;
}

export function exportFileName(locale: string): string {
  return `ui-text-${locale}.json`;
}
