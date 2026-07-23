/**
 * Pure file-parsing + chunking for the bulk unique-code import
 * (../components/UniqueCodeImport.tsx). Row 83.
 *
 * The React component stays thin on purpose: everything decidable from the
 * file's text alone lives here so it can be unit tested without a DOM.
 *
 * THE SERVER CONTRACT THIS FEEDS
 * ------------------------------
 * POST /unique-coupon/upload  { poolDocumentId, codes: string[] }
 *   -> { success: true, imported, skipped, total }
 * (src/plugins/unique-coupon/server/src/controllers/unique-coupon.ts). The
 * controller hard-rejects an empty array and any single request over
 * DEFAULT_CHUNK_SIZE codes — exactly the batches chunkCodes produces.
 *
 * Re-upload is safe: the service ignores conflicts against the database's
 * unique (pool_id, code) index. Dedupe here still removes within-file repeats
 * early so they do not consume request space.
 */

/** Delimiters that end a code when a spreadsheet exports extra columns. */
const FIELD_DELIMITERS = [',', ';', '\t'];

/**
 * Header labels dropped from the first non-blank line. Compared lowercased and
 * space-collapsed. A real coupon code equal to one of these is not worth
 * designing around.
 */
const HEADER_LABELS = new Set([
  'code',
  'codes',
  'coupon',
  'coupons',
  'coupon code',
  'coupon codes',
  'unique code',
  'unique codes',
  'voucher',
  'voucher code',
  'promo code',
  'promocode',
]);

/**
 * `unique_codes.code` is a Strapi `string`, i.e. varchar(255). A longer value
 * is rejected here with a line number rather than failing the whole INSERT
 * batch server-side with an opaque driver error.
 */
export const MAX_CODE_LENGTH = 255;

/**
 * Total-per-file ceiling, enforced client-side so the UI can refuse early.
 * The server's own ceiling is per REQUEST (MAX_CODES_PER_REQUEST = 2,000 in
 * the plugin controller, matching DEFAULT_CHUNK_SIZE below).
 */
export const MAX_CODES_PER_UPLOAD = 100_000;

/**
 * Byte ceiling for the SELECTED file, checked against `file.size` BEFORE the
 * browser reads it into memory. A legitimate import can never exceed the max
 * code count times the max code length (plus a delimiter/newline per line), so
 * anything larger is a mis-selected or pathological file — reject it up front
 * instead of calling `file.text()` and freezing (or crashing) the admin tab.
 */
export const MAX_IMPORT_FILE_BYTES = MAX_CODES_PER_UPLOAD * (MAX_CODE_LENGTH + 2);

/**
 * Codes per HTTP request.
 *
 * Sized against Strapi's koa body parser, whose `jsonLimit` defaults to 1 MB.
 * A 20,000-code file posted in one request would be roughly 20,000 x (code +
 * quotes + comma) — comfortably over that for anything but the shortest codes,
 * and the request would be rejected wholesale with a 413. This remains the
 * maximum item count, while chunkCodes also measures the serialized request's
 * UTF-8 bytes because one JavaScript character can occupy several bytes.
 *
 * The plugin controller enforces this same figure as its per-request maximum
 * (MAX_CODES_PER_REQUEST) — a bigger chunk would be rejected with a 400.
 */
export const DEFAULT_CHUNK_SIZE = 2_000;

/**
 * Hard body budget for one import request. Koa defaults to a 1 MB JSON limit;
 * 900 KB leaves headroom below both decimal and binary interpretations while
 * still fitting roughly 1,100 maximum-length three-byte codes per request.
 */
export const MAX_IMPORT_REQUEST_BYTES = 900_000;

export type CodeIssue = {
  /** 1-based line number in the source file, for an actionable message. */
  line: number;
  value: string;
  reason: 'too-long' | 'control-characters';
};

export type ParsedCodes = {
  /** Unique, validated codes in first-seen order — what gets uploaded. */
  codes: string[];
  /** Non-empty data lines considered (excludes blanks and a dropped header). */
  total: number;
  /** Dropped because the same code appeared earlier in this same file. */
  duplicates: number;
  /** Dropped because the value cannot be stored. */
  invalid: CodeIssue[];
  /** True when the first non-blank line was recognised as a header and dropped. */
  headerSkipped: boolean;
};

const UTF8_ENCODER = new TextEncoder();

const utf8ByteLength = (value: string): number =>
  UTF8_ENCODER.encode(value).byteLength;

const collapse = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The code carried by one line.
 *
 * Takes the FIRST delimited field, so a `code,expiry,batch` spreadsheet export
 * works unchanged. This means a code containing a comma, semicolon or tab
 * cannot be imported — an acceptable trade, since those characters break the
 * merchant checkout forms these codes are pasted into anyway.
 *
 * A surrounding pair of double quotes (how spreadsheets escape fields) is
 * stripped, and doubled inner quotes are unescaped per RFC 4180.
 */
export function extractCode(line: string): string {
  let value = line;

  if (value.startsWith('"')) {
    // Quoted field: read to the closing quote, honouring "" as an escaped ".
    let out = '';
    let index = 1;
    while (index < value.length) {
      if (value[index] === '"') {
        if (value[index + 1] === '"') {
          out += '"';
          index += 2;
          continue;
        }
        break;
      }
      out += value[index];
      index += 1;
    }
    return out.trim();
  }

  for (const delimiter of FIELD_DELIMITERS) {
    const at = value.indexOf(delimiter);
    if (at !== -1) value = value.slice(0, at);
  }

  return value.trim();
}

/**
 * Codes are pasted into merchant checkout forms; C0/C1 control characters
 * never belong and usually mean the file was exported in a binary format
 * (an .xlsx renamed to .csv is the common one).
 */
function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Parse a `.txt` / `.csv` file's text into an uploadable, de-duplicated code
 * list plus the counts the import UI reports.
 *
 * One code per line. Blank lines are ignored entirely and never counted.
 */
export function parseCodesFile(text: string): ParsedCodes {
  const codes: string[] = [];
  const invalid: CodeIssue[] = [];
  const seen = new Set<string>();

  let total = 0;
  let duplicates = 0;
  let headerSkipped = false;

  // Split on CRLF / LF / CR so Windows, Unix and legacy Mac exports all work.
  const lines = text.split(/\r\n|\n|\r/);

  // Header detection targets the first line that CARRIES anything, not
  // physical line 1: exports routinely start with a blank line, and matching
  // on index 0 alone imported the literal "code" header as a coupon code.
  let seenContentLine = false;

  for (const [index, rawLine] of lines.entries()) {
    const value = extractCode(rawLine);
    if (!value) continue;

    const isFirstContentLine = !seenContentLine;
    seenContentLine = true;

    if (isFirstContentLine && HEADER_LABELS.has(collapse(value))) {
      headerSkipped = true;
      continue;
    }

    total += 1;
    const line = index + 1;

    if (hasControlCharacters(value)) {
      invalid.push({ line, value, reason: 'control-characters' });
      continue;
    }
    if (value.length > MAX_CODE_LENGTH) {
      invalid.push({ line, value, reason: 'too-long' });
      continue;
    }

    // Case-SENSITIVE: coupon codes routinely differ only by case, so folding
    // them would silently discard valid stock.
    if (seen.has(value)) {
      duplicates += 1;
      continue;
    }

    seen.add(value);
    codes.push(value);
  }

  return { codes, total, duplicates, invalid, headerSkipped };
}

/**
 * Exact UTF-8 byte size of the JSON body the admin client sends. Exported so
 * tests and future callers can pin the same transport contract as chunkCodes.
 */
export function importRequestByteLength(
  poolDocumentId: string,
  codes: readonly string[],
): number {
  return utf8ByteLength(JSON.stringify({ poolDocumentId, codes }));
}

export type ChunkCodesOptions = {
  poolDocumentId?: string;
  maxRequestBytes?: number;
};

/**
 * Split the upload into request-sized batches, bounded by both item count and
 * the serialized JSON body's UTF-8 byte size. Returns an empty array for an
 * empty input, so the caller never posts the empty payload the controller
 * rejects with a 400.
 */
export function chunkCodes(
  codes: readonly string[],
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  options: ChunkCodesOptions = {},
): string[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const poolDocumentId = options.poolDocumentId ?? '';
  const emptyRequestBytes = importRequestByteLength(poolDocumentId, []);
  const configuredBudget =
    options.maxRequestBytes ?? MAX_IMPORT_REQUEST_BYTES;
  const maxRequestBytes = Number.isFinite(configuredBudget)
    ? Math.max(1, Math.floor(configuredBudget))
    : MAX_IMPORT_REQUEST_BYTES;
  if (emptyRequestBytes >= maxRequestBytes) {
    throw new RangeError(
      'Import request metadata exceeds the configured byte limit.',
    );
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = emptyRequestBytes;

  for (const code of codes) {
    const serializedCodeBytes = utf8ByteLength(JSON.stringify(code));
    const nextEntryBytes = serializedCodeBytes + (current.length > 0 ? 1 : 0);

    if (
      current.length > 0 &&
      (current.length >= size ||
        currentBytes + nextEntryBytes > maxRequestBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = emptyRequestBytes;
    }

    const entryBytes = serializedCodeBytes + (current.length > 0 ? 1 : 0);
    if (currentBytes + entryBytes > maxRequestBytes) {
      throw new RangeError(
        'A single code exceeds the configured import request byte limit.',
      );
    }
    current.push(code);
    currentBytes += entryBytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export type ImportSummary = {
  /** Rows the server reported inserting. */
  imported: number;
  /** Dropped before upload: in-file duplicates + unusable values. */
  skipped: number;
  /** Codes in chunks whose request failed. */
  failed: number;
  /** One message per failed chunk, for the error list. */
  errors: string[];
};

export type ChunkImportResult = {
  count: number;
  /** Exact codes in this request, retained only when its request fails. */
  codes?: readonly string[];
  imported?: number;
  /** Existing rows the server ignored safely. */
  skipped?: number;
  error?: string;
};

/**
 * Fold per-chunk results into the imported / skipped / failed the UI shows.
 * Pure so the arithmetic is testable without mocking a network.
 */
export function summariseImport(
  parsed: ParsedCodes,
  chunkResults: readonly ChunkImportResult[],
): ImportSummary {
  let imported = 0;
  let serverSkipped = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const result of chunkResults) {
    if (result.error) {
      failed += result.count;
      errors.push(result.error);
      continue;
    }
    imported += result.imported ?? 0;
    serverSkipped += result.skipped ?? 0;
  }

  return {
    imported,
    skipped: parsed.duplicates + parsed.invalid.length + serverSkipped,
    failed,
    errors,
  };
}

export type ImportCompletion = {
  summary: ImportSummary;
  /** Only failed HTTP batches remain uploadable; null means the import ended. */
  parsed: ParsedCodes | null;
  fileName: string | null;
};

/**
 * Reduce one completed request loop into the next UI state. Successful chunks
 * are removed permanently; failed chunks remain available for a one-click
 * retry without resubmitting stock that the server already accepted.
 */
export function reduceImportCompletion(
  parsed: ParsedCodes,
  fileName: string | null,
  chunkResults: readonly ChunkImportResult[],
): ImportCompletion {
  const retryCodes = chunkResults.flatMap((result) =>
    result.error ? [...(result.codes ?? [])] : [],
  );

  return {
    summary: summariseImport(parsed, chunkResults),
    parsed: retryCodes.length > 0
      ? {
          codes: retryCodes,
          total: retryCodes.length,
          duplicates: 0,
          invalid: [],
          headerSkipped: false,
        }
      : null,
    fileName: retryCodes.length > 0 ? fileName : null,
  };
}

/**
 * Why an upload cannot start, or null when it can. Keeps the component from
 * firing requests the controller would reject anyway.
 */
export function uploadBlocker(parsed: ParsedCodes): string | null {
  if (parsed.codes.length === 0) {
    return 'No usable codes found in this file.';
  }
  if (parsed.codes.length > MAX_CODES_PER_UPLOAD) {
    return `This file has ${parsed.codes.length.toLocaleString()} codes. Imports accept at most ${MAX_CODES_PER_UPLOAD.toLocaleString()} codes per file — split the file.`;
  }
  return null;
}
